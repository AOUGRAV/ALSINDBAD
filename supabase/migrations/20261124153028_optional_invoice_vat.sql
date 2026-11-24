begin;

alter table public.entries add column invoice_vat_percent integer not null default 15
  check (invoice_vat_percent in (0, 15));

create function alsindbad_private.invoice_load_cost(invoice_row public.entries, item_index integer, loaded_quantity numeric) returns bigint
language sql immutable strict set search_path = ''
as $$
  with amounts as (
    select coalesce(sum(round((item->>'quantity')::numeric * (item->>'unit_price')::numeric)), 0) as net_before
    from jsonb_array_elements((invoice_row).invoice_items) with ordinality as preceding(item, position)
    where position <= item_index
  ), cumulative as (
    select net_before,
      net_before + round(((invoice_row).invoice_items->item_index->>'quantity')::numeric *
        ((invoice_row).invoice_items->item_index->>'unit_price')::numeric) as net_after
    from amounts
  )
  select round((
    round((net_after + round(net_after * (invoice_row).invoice_vat_percent / 100)) * (invoice_row).rate) -
    round((net_before + round(net_before * (invoice_row).invoice_vat_percent / 100)) * (invoice_row).rate)
  ) * loaded_quantity / ((invoice_row).invoice_items->item_index->>'quantity')::numeric)::bigint
  from cumulative;
$$;
revoke all on function alsindbad_private.invoice_load_cost(public.entries, integer, numeric) from public, anon, authenticated;

create function alsindbad_private.refresh_invoice_vat_costs() returns trigger
language plpgsql set search_path = ''
as $$
begin
  update public.container_invoice_loads l
    set cost_sar = alsindbad_private.invoice_load_cost(new, l.item_index, l.quantity)
    where l.owner_id = new.owner_id and l.entry_id = new.id and l.included;
  update public.containers c set manifest_revision = manifest_revision + 1
    where c.owner_id = new.owner_id and exists (
      select 1 from public.container_invoice_loads l
      where l.owner_id = new.owner_id and l.entry_id = new.id and l.container_id = c.id and l.included
    );
  return new;
end;
$$;
revoke all on function alsindbad_private.refresh_invoice_vat_costs() from public, anon, authenticated;
create trigger refresh_invoice_vat_costs after update of invoice_vat_percent on public.entries
  for each row when (old.invoice_vat_percent is distinct from new.invoice_vat_percent)
  execute function alsindbad_private.refresh_invoice_vat_costs();


create function public.purchase_invoice_total(items jsonb, vat_percent integer) returns bigint
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
  if jsonb_array_length(items) not between 1 and 50 then
    raise exception 'An invoice must contain 1 to 50 items';
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
revoke all on function public.purchase_invoice_total(jsonb, integer) from public, anon;
grant execute on function public.purchase_invoice_total(jsonb, integer) to authenticated;


create or replace function public.purchase_invoice_total(items jsonb) returns bigint
language sql immutable strict set search_path = ''
as $$ select public.purchase_invoice_total(items, 15); $$;

alter table public.entries drop constraint entries_purchase_invoice_total_check,
  add constraint entries_purchase_invoice_total_check check (
    invoice_items is null or amount = public.purchase_invoice_total(invoice_items, invoice_vat_percent)
  );


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
    if (to_jsonb(existing) - 'created_at') = (to_jsonb(candidate) - 'created_at') then return; end if;
    raise exception 'This transaction was already recorded. Refresh the ledger.' using errcode = '23505';
  end if;
  perform public.assert_entry_candidate(candidate);
  insert into public.entries select (candidate).*;
end;
$$;
revoke all on function public.record_entry(jsonb) from public, anon;
grant execute on function public.record_entry(jsonb) to authenticated;

create or replace function public.revise_entry(
  target uuid, expected integer, reason text, payload jsonb default null
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  original public.entries;
  candidate public.entries;
  voiding boolean := payload is null;
  settled bigint;
  first_payment date;
  principal bigint;
  purchased bigint;
  loaded bigint;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if reason is null or char_length(btrim(reason)) not between 1 and 500 then
    raise exception 'A correction reason is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select * into original from public.entries where id = target and owner_id = caller;
  if not found then raise exception 'Transaction not found'; end if;
  if original.voided_at is not null or original.revision is distinct from expected then
    raise exception 'This transaction changed. Refresh the ledger before retrying.';
  end if;

  if not voiding then
    candidate := jsonb_populate_record(original, payload);
    candidate.id := original.id;
    candidate.owner_id := caller;
    candidate.created_at := original.created_at;
    candidate.revision := original.revision + 1;
    candidate.voided_at := null;
    candidate.custody_excluded := coalesce(candidate.custody_excluded, false);
    candidate.invoice_vat_percent := coalesce(candidate.invoice_vat_percent, 15);
    candidate.paid_outside_custody := coalesce(candidate.paid_outside_custody, false);
    if candidate.kind is distinct from original.kind or candidate.settles_id is distinct from original.settles_id then
      raise exception 'Transaction type and debt link cannot be changed during a correction';
    end if;
    perform public.assert_entry_candidate(candidate);
  end if;

  select coalesce(sum(e.amount), 0), min(e.date) into settled, first_payment
    from public.entries as e where e.owner_id = caller and e.settles_id = target and e.voided_at is null;
  if settled > 0 then
    if voiding then raise exception 'Reverse the linked payments before voiding this debt'; end if;
    principal := case candidate.kind when 'purchase' then candidate.amount - candidate.paid else candidate.amount end;
    if candidate.currency is distinct from original.currency or candidate.party is distinct from original.party
      or candidate.scope is distinct from original.scope or candidate.date > first_payment or principal < settled then
      raise exception 'The correction must preserve the linked payments and their debt balance';
    end if;
  end if;

  if original.product_id is not null then
    select coalesce(sum(e.quantity), 0) into purchased from public.entries as e
      where e.owner_id = caller and e.product_id = original.product_id and e.voided_at is null and e.id <> target;
    select coalesce(sum(l.quantity), 0) into loaded from public.loads as l
      where l.owner_id = caller and l.product_id = original.product_id;
    if not voiding and candidate.product_id = original.product_id then
      purchased := purchased + candidate.quantity;
    end if;
    if purchased < loaded then raise exception 'The correction would remove stock already loaded in a container'; end if;
  end if;

  insert into public.entry_history (owner_id, entry_id, revision, action, reason, previous)
    values (caller, target, original.revision, case when voiding then 'void' else 'correct' end, btrim(reason), to_jsonb(original) - 'owner_id');
  if voiding then
    update public.entries set voided_at = now(), revision = original.revision + 1 where id = target and owner_id = caller;
  else
    update public.entries
    set date = candidate.date, party = candidate.party, description = candidate.description,
      category = candidate.category, scope = candidate.scope, currency = candidate.currency,
      amount = candidate.amount, paid = candidate.paid, rate = candidate.rate, method = candidate.method,
      product_id = candidate.product_id, quantity = candidate.quantity, receipt_path = candidate.receipt_path,
      container_id = candidate.container_id, opening = candidate.opening, revision = candidate.revision,
      invoice_number = candidate.invoice_number, invoice_items = candidate.invoice_items, notes = candidate.notes,
      paid_outside_custody = candidate.paid_outside_custody, custody_excluded = candidate.custody_excluded,
      invoice_vat_percent = candidate.invoice_vat_percent
    where id = target and owner_id = caller;
  end if;
end;
$$;
revoke all on function public.revise_entry(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.revise_entry(uuid, integer, text, jsonb) to authenticated;

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

commit;
