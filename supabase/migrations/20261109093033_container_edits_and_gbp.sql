begin;

alter table public.containers
  add column gbp_rate numeric(12,6) check (gbp_rate between 0.000001 and 10000);

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
  net_before numeric;
  net_after numeric;
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
    where l.entry_id is null or l.item_index is null or l.item_index not between 0 and 49
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
    -- Use cumulative rounded totals to distribute invoice VAT and FX across whole lines.
    select coalesce(sum(round((item->>'quantity')::numeric * (item->>'unit_price')::numeric)), 0) into net_before
      from jsonb_array_elements(invoice.invoice_items) with ordinality as preceding(item, position)
      where position <= requested.item_index;
    net_after := net_before + round(invoice_quantity * (invoice_item->>'unit_price')::numeric);
    item_cost := round((round((net_after + round(net_after * 0.15)) * invoice.rate)
      - round((net_before + round(net_before * 0.15)) * invoice.rate)) * requested.quantity / invoice_quantity);
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

create or replace function public.advance_container(target uuid, expected text) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  current_status text;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select status into current_status from public.containers where id = target and owner_id = caller;
  if not found then raise exception 'Container not found'; end if;
  if current_status is distinct from expected then raise exception 'Container status has changed. Refresh the page.'; end if;
  if current_status = 'arrived' then raise exception 'Container has already arrived'; end if;
  if current_status = 'preparing' and not exists (
    select 1 from public.loads where owner_id = caller and container_id = target
    union all
    select 1 from public.container_invoice_loads where owner_id = caller and container_id = target and included
  ) then raise exception 'Load stock before recording shipment'; end if;

  update public.containers set status = case current_status when 'preparing' then 'shipped' else 'arrived' end,
    manifest_revision = manifest_revision + 1
    where id = target and owner_id = caller;
end;
$$;

commit;
