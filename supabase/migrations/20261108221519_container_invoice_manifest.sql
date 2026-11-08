begin;

alter table public.containers
  add column manifest_revision integer not null default 0 check (manifest_revision >= 0);

create table public.container_invoice_loads (
  owner_id uuid not null,
  container_id uuid not null,
  entry_id uuid not null,
  item_index integer not null check (item_index between 0 and 49),
  quantity numeric(12,3) not null check (quantity between 0.001 and 100000000),
  cost_sar bigint not null check (cost_sar >= 0),
  included boolean not null default true,
  primary key (owner_id, container_id, entry_id, item_index),
  foreign key (owner_id, container_id) references public.containers(owner_id, id),
  foreign key (owner_id, entry_id) references public.entries(owner_id, id)
);
create index container_invoice_loads_entry_item on public.container_invoice_loads(owner_id, entry_id, item_index);
alter table public.container_invoice_loads enable row level security;
revoke all on public.container_invoice_loads from public, anon, authenticated;
grant select on public.container_invoice_loads to authenticated;
create policy read_container_invoice_loads on public.container_invoice_loads for select to authenticated
  using (included and owner_id = (select auth.uid()) and (select public.is_workspace_member()));

create schema alsindbad_private;
revoke all on schema alsindbad_private from public, anon, authenticated;
grant usage on schema alsindbad_private to authenticated;

create function alsindbad_private.save_container_manifest(payload jsonb, lines jsonb, expected integer) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  target uuid := (payload->>'id')::uuid;
  existing public.containers;
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
  if found then
    if existing.status <> 'preparing' then
      raise exception 'لا يمكن تعديل الحمولة بعد الشحن / Container has shipped';
    end if;
    if expected is null and (
      existing.name is distinct from btrim(payload->>'name')
      or existing.destination is distinct from btrim(payload->>'destination')
      or existing.booking is distinct from coalesce(btrim(payload->>'booking'), '')
    ) then raise exception 'الحاوية مسجلة مسبقًا / Container already exists'; end if;

    select coalesce(jsonb_agg(to_jsonb(l) order by l.entry_id, l.item_index), '[]'::jsonb) into desired
      from jsonb_to_recordset(lines) as l(entry_id uuid, item_index integer, quantity numeric);
    select coalesce(jsonb_agg(jsonb_build_object('entry_id', l.entry_id, 'item_index', l.item_index, 'quantity', l.quantity)
      order by l.entry_id, l.item_index), '[]'::jsonb) into stored
      from public.container_invoice_loads as l where l.owner_id = caller and l.container_id = target and l.included;
    if desired = stored then return; end if;
    if expected is distinct from existing.manifest_revision then
      raise exception 'تغيّرت الحمولة. حدّث البيانات قبل التعديل / Manifest changed. Refresh the records.';
    end if;
  else
    if expected is not null then raise exception 'الحاوية غير موجودة / Container not found'; end if;
    insert into public.containers (id, owner_id, name, destination, booking)
    values (target, caller, btrim(payload->>'name'), btrim(payload->>'destination'), coalesce(btrim(payload->>'booking'), ''));
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
  update public.containers set manifest_revision = manifest_revision + 1 where owner_id = caller and id = target;
end;
$$;
revoke all on function alsindbad_private.save_container_manifest(jsonb, jsonb, integer) from public, anon;
grant execute on function alsindbad_private.save_container_manifest(jsonb, jsonb, integer) to authenticated;

create function public.save_container_manifest(payload jsonb, lines jsonb, expected integer default null) returns void
language sql security invoker set search_path = ''
as $$
  select alsindbad_private.save_container_manifest(payload, lines, expected);
$$;
revoke all on function public.save_container_manifest(jsonb, jsonb, integer) from public, anon;
grant execute on function public.save_container_manifest(jsonb, jsonb, integer) to authenticated;

-- Invoice corrections and manifest writes share the per-owner ledger lock.
create function public.keep_allocated_invoice_items() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if exists (
    select 1 from public.container_invoice_loads as l
    where l.owner_id = old.owner_id and l.entry_id = old.id and l.included
    group by l.item_index
    having new.voided_at is not null
      or (new.invoice_items->l.item_index->'name') is distinct from (old.invoice_items->l.item_index->'name')
      or (new.invoice_items->l.item_index->'unit') is distinct from (old.invoice_items->l.item_index->'unit')
      or coalesce((new.invoice_items->l.item_index->>'quantity')::numeric, 0) < sum(l.quantity)
  ) then
    raise exception 'فيه كميات من الفاتورة مرتبطة بحاوية. راجع الحمولة أولًا. / Invoice quantities are assigned to a container.';
  end if;
  return new;
end;
$$;
revoke all on function public.keep_allocated_invoice_items() from public, anon, authenticated;
create trigger keep_allocated_invoice_items
before update of invoice_items, voided_at on public.entries for each row execute function public.keep_allocated_invoice_items();

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

  update public.containers set status = case current_status when 'preparing' then 'shipped' else 'arrived' end
    where id = target and owner_id = caller;
end;
$$;

create or replace function public.workspace_snapshot() returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select case when public.is_workspace_member() then jsonb_build_object(
    'entries', coalesce((select jsonb_agg(to_jsonb(e) - 'owner_id') from public.entries as e), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(p) - 'owner_id') from public.products as p), '[]'::jsonb),
    'containers', coalesce((select jsonb_agg(to_jsonb(c) - 'owner_id') from public.containers as c), '[]'::jsonb),
    'loads', coalesce((select jsonb_agg(to_jsonb(l) - 'owner_id') from public.loads as l), '[]'::jsonb),
    'invoice_loads', coalesce((select jsonb_agg(to_jsonb(l) - 'owner_id' - 'included') from public.container_invoice_loads as l where l.included), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(to_jsonb(h) - 'owner_id') from public.entry_history as h), '[]'::jsonb)
  ) end;
$$;

commit;
