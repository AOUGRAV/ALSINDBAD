begin;

create function alsindbad_private.standard_purchase_unit(unit text) returns text
language sql immutable strict set search_path = '' as $$
  select case
    when cleaned in ('درزن', 'دزن', 'دزينة', 'dozen', 'doz', 'dz') then 'درزن'
    when cleaned in ('كرتون', 'كرتونة', 'كرتونه', 'كراتين', 'carton', 'cartons', 'ctn', 'ctns', 'crt', 'crtn') then 'كرتون'
    when cleaned in ('كيس', 'أكياس', 'اكياس', 'bag', 'bags', 'sack') then 'كيس'
    else unit
  end
  from (select lower(regexp_replace(btrim(normalize(unit, NFKC)), '[.ـً-ٟ]', '', 'g')) as cleaned) as normalized;
$$;

alter table public.container_invoice_loads
  drop constraint container_invoice_loads_item_index_check,
  add constraint container_invoice_loads_item_index_check check (item_index between 0 and 99);

create or replace function public.purchase_invoice_total(items jsonb, vat_percent integer) returns bigint
language plpgsql immutable strict set search_path = ''
as $$
declare
  item jsonb;
  quantity numeric;
  unit_price numeric;
  subtotal numeric := 0;
  total numeric;
begin
  if vat_percent not in (0, 15) then raise exception 'Invalid invoice VAT'; end if;
  if jsonb_typeof(items) <> 'array' then
    raise exception 'Invoice items must be an array';
  end if;
  if jsonb_array_length(items) not between 1 and 100 then
    raise exception 'An invoice must contain 1 to 100 items';
  end if;

  for item in select value from jsonb_array_elements(items) loop
    if jsonb_typeof(item->'name') is distinct from 'string'
      or char_length(btrim(item->>'name')) not between 1 and 140
      or jsonb_typeof(item->'unit') is distinct from 'string'
      or char_length(btrim(item->>'unit')) not between 1 and 30
      or jsonb_typeof(item->'quantity') is distinct from 'number'
      or jsonb_typeof(item->'unit_price') is distinct from 'number' then
      raise exception 'Invalid invoice item';
    end if;
    quantity := (item->>'quantity')::numeric;
    unit_price := (item->>'unit_price')::numeric;
    if quantity not between 0.001 and 100000000 or quantity <> round(quantity, 3)
      or unit_price not between 0 and 100000000000 or unit_price <> trunc(unit_price) then
      raise exception 'Invalid invoice quantity or unit price';
    end if;
    subtotal := subtotal + round(quantity * unit_price);
  end loop;

  total := subtotal + round(subtotal * vat_percent / 100);
  if total not between 1 and 100000000000 then
    raise exception 'Invoice total is out of range';
  end if;
  return total::bigint;
end;
$$;

create or replace function alsindbad_private.save_container_manifest(payload jsonb, lines jsonb, expected integer) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target uuid := (payload->>'id')::uuid;
  existing public.containers;
  next_name text;
  next_destination text;
  next_booking text;
  next_status text;
  next_rate numeric;
  invoice public.entries;
  requested record;
  invoice_item jsonb;
  invoice_quantity numeric;
  selected_quantity numeric;
  item_cost bigint;
  desired jsonb;
  stored jsonb;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  if target is null or jsonb_typeof(lines) is distinct from 'array' then
    raise exception 'بيانات الحمولة غير صحيحة / Invalid manifest';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(lines) as l(entry_id uuid, item_index integer, quantity numeric)
    where l.entry_id is null or l.item_index is null or l.item_index not between 0 and 99
      or l.quantity is null or l.quantity not between 0.001 and 100000000 or l.quantity <> round(l.quantity, 3)
  ) or exists (
    select 1 from jsonb_to_recordset(lines) as l(entry_id uuid, item_index integer)
    group by l.entry_id, l.item_index having count(*) > 1
  ) then raise exception 'بيانات بنود الحمولة غير صحيحة / Invalid manifest lines'; end if;

  select * into existing from public.containers where owner_id = caller and id = target;
  next_name := coalesce(btrim(payload->>'name'), existing.name);
  next_destination := coalesce(btrim(payload->>'destination'), existing.destination);
  next_booking := coalesce(btrim(payload->>'booking'), existing.booking, '');
  next_status := coalesce(payload->>'status', existing.status, 'preparing');
  next_rate := case when payload ? 'gbp_rate' then (payload->>'gbp_rate')::numeric else existing.gbp_rate end;

  if next_status not in ('preparing', 'shipped', 'arrived') then
    raise exception 'حالة الحاوية غير صحيحة / Invalid container status';
  end if;
  if next_rate is not null and (next_rate not between 0.000001 and 10000 or next_rate <> round(next_rate, 6)) then
    raise exception 'سعر صرف الجنيه غير صحيح / Invalid GBP exchange rate';
  end if;
  if next_status <> 'preparing' and jsonb_array_length(lines) = 0 and not exists (
    select 1 from public.loads where owner_id = caller and container_id = target
  ) then raise exception 'أضف حمولة قبل تسجيل الشحن / Add cargo before recording shipment'; end if;

  if existing.id is not null then
    select coalesce(jsonb_agg(to_jsonb(l) order by l.entry_id, l.item_index), '[]'::jsonb) into desired
      from jsonb_to_recordset(lines) as l(entry_id uuid, item_index integer, quantity numeric);
    select coalesce(jsonb_agg(jsonb_build_object('entry_id', l.entry_id, 'item_index', l.item_index, 'quantity', l.quantity)
      order by l.entry_id, l.item_index), '[]'::jsonb) into stored
      from public.container_invoice_loads as l where l.owner_id = caller and l.container_id = target and l.included;
    if desired = stored and (next_name, next_destination, next_booking, next_status, next_rate)
      is not distinct from (existing.name, existing.destination, existing.booking, existing.status, existing.gbp_rate)
    then return; end if;
    if expected is null then raise exception 'الحاوية مسجلة مسبقًا / Container already exists'; end if;
    if expected is distinct from existing.manifest_revision then
      raise exception 'تغيّرت الحاوية. حدّث البيانات قبل التعديل / Container changed. Refresh the records.';
    end if;
  else
    if expected is not null then raise exception 'الحاوية غير موجودة / Container not found'; end if;
    insert into public.containers (id, owner_id, name, destination, booking)
    values (target, caller, next_name, next_destination, next_booking);
  end if;

  for requested in select * from jsonb_to_recordset(lines) as l(entry_id uuid, item_index integer, quantity numeric) loop
    select * into invoice from public.entries
      where owner_id = caller and id = requested.entry_id and kind = 'purchase' and voided_at is null;
    invoice_item := invoice.invoice_items->requested.item_index;
    if invoice_item is null then raise exception 'بند الفاتورة غير موجود / Invoice line not found'; end if;
    invoice_quantity := (invoice_item->>'quantity')::numeric;
    select coalesce(sum(quantity), 0) into selected_quantity from public.container_invoice_loads
      where owner_id = caller and entry_id = requested.entry_id and item_index = requested.item_index and container_id <> target and included;
    if requested.quantity + selected_quantity > invoice_quantity then
      raise exception 'الكمية تتجاوز المتاح من الفاتورة / Quantity exceeds the available invoice quantity';
    end if;
    item_cost := alsindbad_private.invoice_load_cost(invoice, requested.item_index, requested.quantity);
    insert into public.container_invoice_loads as current_load (owner_id, container_id, entry_id, item_index, quantity, cost_sar)
    values (caller, target, requested.entry_id, requested.item_index, requested.quantity, item_cost)
    on conflict (owner_id, container_id, entry_id, item_index) do update
      set quantity = excluded.quantity, cost_sar = excluded.cost_sar, included = true
      where not current_load.included or current_load.quantity is distinct from excluded.quantity;
  end loop;

  update public.container_invoice_loads as l set included = false
  where l.owner_id = caller and l.container_id = target and l.included and not exists (
    select 1 from jsonb_to_recordset(lines) as keep(entry_id uuid, item_index integer)
    where keep.entry_id = l.entry_id and keep.item_index = l.item_index
  );
  update public.containers set name = next_name, destination = next_destination, booking = next_booking,
    status = next_status, gbp_rate = next_rate, manifest_revision = manifest_revision + 1
    where owner_id = caller and id = target;
end;
$$;

create or replace function public.keep_allocated_invoice_items() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if exists (
    select 1 from public.container_invoice_loads as l
    where l.owner_id = old.owner_id and l.entry_id = old.id and l.included
    group by l.item_index
    having new.voided_at is not null
      or (new.invoice_items->l.item_index->'name') is distinct from (old.invoice_items->l.item_index->'name')
      or alsindbad_private.standard_purchase_unit(new.invoice_items->l.item_index->>'unit')
        is distinct from alsindbad_private.standard_purchase_unit(old.invoice_items->l.item_index->>'unit')
      or coalesce((new.invoice_items->l.item_index->>'quantity')::numeric, 0) < sum(l.quantity)
  ) then
    raise exception 'فيه كميات من الفاتورة مرتبطة بحاوية. راجع الحمولة أولًا. / Invoice quantities are assigned to a container.';
  end if;
  return new;
end;
$$;

create or replace function alsindbad_private.keep_invoice_export_details() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  item jsonb;
  previous_item jsonb;
  updated jsonb := '[]'::jsonb;
  position integer := 0;
begin
  if new.invoice_items is null then return new; end if;
  if jsonb_typeof(new.invoice_items) is distinct from 'array' then
    raise exception 'Invalid invoice items';
  end if;
  for item in select value from jsonb_array_elements(new.invoice_items) loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid invoice item'; end if;
    if jsonb_typeof(item->'unit') = 'string' then
      item := item || jsonb_build_object('unit', alsindbad_private.standard_purchase_unit(item->>'unit'));
    end if;
    if tg_op = 'UPDATE' then
      previous_item := old.invoice_items->position;
      if item->'name' = previous_item->'name' and (item->>'unit') = alsindbad_private.standard_purchase_unit(previous_item->>'unit') then
        if not (item ? 'name_en') and previous_item ? 'name_en' then
          item := item || jsonb_build_object('name_en', previous_item->'name_en');
        end if;
        if not (item ? 'export_excluded') and previous_item ? 'export_excluded' then
          item := item || jsonb_build_object('export_excluded', previous_item->'export_excluded');
        end if;
      end if;
    end if;
    if item ? 'name_en' then
      if jsonb_typeof(item->'name_en') is distinct from 'string' or char_length(item->>'name_en') > 180 then
        raise exception 'اسم المنتج الإنجليزي غير صحيح / Invalid English product name';
      end if;
      item := item || jsonb_build_object('name_en', btrim(item->>'name_en'));
    end if;
    if item ? 'export_excluded' and jsonb_typeof(item->'export_excluded') is distinct from 'boolean' then
      raise exception 'خيار إظهار المنتج غير صحيح / Invalid statement visibility';
    end if;
    updated := updated || jsonb_build_array(item);
    position := position + 1;
  end loop;
  new.invoice_items := updated;
  return new;
end;
$$;

create function alsindbad_private.standard_invoice_purchase_units(items jsonb) returns jsonb
language sql immutable strict set search_path = '' as $$
  select case when jsonb_typeof(items) = 'array' then (
    select coalesce(jsonb_agg(case when jsonb_typeof(item->'unit') = 'string'
      then item || jsonb_build_object('unit', alsindbad_private.standard_purchase_unit(item->>'unit'))
      else item end order by position), '[]'::jsonb)
    from jsonb_array_elements(items) with ordinality as a(item, position)
  ) else items end;
$$;

create or replace function public.record_entry(payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate public.entries;
  existing public.entries;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  candidate := jsonb_populate_record(null::public.entries, payload);
  candidate.invoice_items := alsindbad_private.standard_invoice_purchase_units(candidate.invoice_items);
  candidate.owner_id := caller;
  candidate.created_at := now();
  candidate.opening := coalesce(candidate.opening, false);
  candidate.paid_outside_custody := coalesce(candidate.paid_outside_custody, false);
  candidate.custody_excluded := coalesce(candidate.custody_excluded, false);
  candidate.invoice_vat_percent := coalesce(candidate.invoice_vat_percent, 15);
  candidate.revision := 1;
  candidate.voided_at := null;

  select * into existing from public.entries where id = candidate.id and owner_id = caller;
  if found then
    existing.invoice_items := alsindbad_private.standard_invoice_purchase_units(existing.invoice_items);
    if (to_jsonb(existing) - 'created_at') = (to_jsonb(candidate) - 'created_at') then return; end if;
    raise exception 'This transaction was already recorded. Refresh the ledger.' using errcode = '23505';
  end if;
  perform public.assert_entry_candidate(candidate);
  insert into public.entries select (candidate).*;
end;
$$;

commit;
