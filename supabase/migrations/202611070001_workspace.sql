begin;

create table public.workspace_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (char_length(btrim(name)) between 1 and 140),
  category text not null check (char_length(btrim(category)) between 1 and 80),
  unit text not null check (char_length(btrim(unit)) between 1 and 30),
  expiry date,
  created_at timestamptz not null default now(),
  unique (owner_id, id)
);

create table public.containers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  destination text not null check (char_length(btrim(destination)) between 1 and 120),
  booking text not null default '' check (char_length(booking) <= 100),
  status text not null default 'preparing' check (status in ('preparing', 'shipped', 'arrived')),
  created_at timestamptz not null default now(),
  unique (owner_id, id)
);
create unique index containers_owner_name on public.containers(owner_id, lower(btrim(name)));

-- Amounts use minor currency units. A rate records SAR per unit of the original currency.
create table public.entries (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  date date not null,
  kind text not null check (kind in ('funding', 'borrow', 'lend', 'purchase', 'expense', 'asset', 'collect', 'repay')),
  party text not null check (char_length(btrim(party)) between 1 and 120),
  description text not null check (char_length(btrim(description)) between 1 and 500),
  category text not null check (char_length(btrim(category)) between 1 and 80),
  scope text not null check (scope in ('business', 'personal')),
  currency text not null check (currency in ('SAR', 'USD', 'GBP', 'EUR')),
  amount bigint not null check (amount between 1 and 100000000000),
  paid bigint not null check (paid between 0 and amount),
  rate numeric(12,6) not null check (rate > 0 and rate <= 10000 and (currency <> 'SAR' or rate = 1)),
  method text not null check (method in ('cash', 'bank', 'card')),
  product_id uuid,
  quantity integer not null default 0 check (quantity between 0 and 100000000),
  settles_id uuid,
  container_id uuid,
  receipt_path text,
  created_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, product_id) references public.products(owner_id, id),
  foreign key (owner_id, settles_id) references public.entries(owner_id, id),
  foreign key (owner_id, container_id) references public.containers(owner_id, id),
  check (kind = 'purchase' or paid = amount),
  check ((kind = 'purchase' and product_id is not null and quantity > 0)
    or (kind <> 'purchase' and product_id is null and quantity = 0)),
  check ((kind in ('collect', 'repay')) = (settles_id is not null)),
  check (container_id is null or (kind = 'expense' and scope = 'business'))
);
create index entries_owner_date on public.entries(owner_id, date);
create index entries_owner_debt on public.entries(owner_id, settles_id) where settles_id is not null;
create index entries_owner_product on public.entries(owner_id, product_id) where product_id is not null;

create table public.loads (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  container_id uuid not null,
  product_id uuid not null,
  quantity integer not null check (quantity between 1 and 100000000),
  created_at timestamptz not null default now(),
  foreign key (owner_id, container_id) references public.containers(owner_id, id),
  foreign key (owner_id, product_id) references public.products(owner_id, id)
);
create index loads_owner_product on public.loads(owner_id, product_id);
create index loads_owner_container on public.loads(owner_id, container_id);

alter table public.workspace_members enable row level security;
alter table public.products enable row level security;
alter table public.containers enable row level security;
alter table public.entries enable row level security;
alter table public.loads enable row level security;

revoke all on public.workspace_members, public.products, public.containers, public.entries, public.loads from public, anon, authenticated;
grant select on public.products, public.containers, public.entries, public.loads to authenticated;
grant insert (id, owner_id, name, category, unit, expiry) on public.products to authenticated;
grant insert (id, owner_id, name, destination, booking) on public.containers to authenticated;

create function public.is_workspace_member() returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.workspace_members where user_id = (select auth.uid()));
$$;
revoke all on function public.is_workspace_member() from public, anon;
grant execute on function public.is_workspace_member() to authenticated;

create policy read_products on public.products for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy write_products on public.products for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy read_containers on public.containers for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy write_containers on public.containers for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy read_entries on public.entries for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy read_loads on public.loads for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
create policy read_receipts on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and split_part(name, '/', 1) = (select auth.uid())::text and (select public.is_workspace_member()));
create policy write_receipts on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and split_part(name, '/', 1) = (select auth.uid())::text and (select public.is_workspace_member()));

create function public.record_entry(payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate public.entries;
  existing public.entries;
  debt public.entries;
  principal bigint;
  settled bigint;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  -- Serializes entry, load and status changes made concurrently by the shared account.
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  candidate := jsonb_populate_record(null::public.entries, payload);
  candidate.owner_id := caller;
  candidate.created_at := now();

  select * into existing from public.entries where id = candidate.id and owner_id = caller;
  if found then
    if (to_jsonb(existing) - 'created_at') = (to_jsonb(candidate) - 'created_at') then return; end if;
    raise exception 'This transaction was already recorded. Refresh the ledger.' using errcode = '23505';
  end if;

  if candidate.receipt_path is not null then
    if strpos(candidate.receipt_path, caller::text || '/' || candidate.id::text || '-') <> 1 or not exists (
      select 1 from storage.objects where bucket_id = 'receipts' and name = candidate.receipt_path
    ) then
      raise exception 'Receipt is missing or belongs to a different transaction';
    end if;
  end if;

  if candidate.settles_id is not null then
    select * into debt from public.entries where id = candidate.settles_id and owner_id = caller;
    if not found then raise exception 'Debt not found'; end if;

    principal := case debt.kind when 'purchase' then debt.amount - debt.paid
      when 'lend' then debt.amount when 'borrow' then debt.amount else 0 end;
    if principal <= 0 or candidate.kind <> (case debt.kind when 'lend' then 'collect' else 'repay' end) then
      raise exception 'Invalid debt settlement';
    end if;
    if candidate.currency <> debt.currency or candidate.party <> debt.party or candidate.scope <> debt.scope then
      raise exception 'Settlement must match the debt currency, party, and scope';
    end if;
    if candidate.date < debt.date then raise exception 'Settlement predates debt'; end if;

    select coalesce(sum(amount), 0) into settled from public.entries where owner_id = caller and settles_id = debt.id;
    if candidate.amount > principal - settled then raise exception 'Settlement exceeds outstanding balance'; end if;
  end if;

  insert into public.entries select (candidate).*;
end;
$$;

create function public.record_load(payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate public.loads;
  existing public.loads;
  purchased bigint;
  loaded bigint;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  candidate := jsonb_populate_record(null::public.loads, payload);
  candidate.owner_id := caller;
  candidate.created_at := now();

  select * into existing from public.loads where id = candidate.id and owner_id = caller;
  if found then
    if (to_jsonb(existing) - 'created_at') = (to_jsonb(candidate) - 'created_at') then return; end if;
    raise exception 'This load was already recorded. Refresh the inventory.' using errcode = '23505';
  end if;

  if not exists (select 1 from public.containers where id = candidate.container_id and owner_id = caller and status = 'preparing') then
    raise exception 'Container is not open';
  end if;
  select coalesce(sum(quantity), 0) into purchased from public.entries where owner_id = caller and product_id = candidate.product_id;
  select coalesce(sum(quantity), 0) into loaded from public.loads where owner_id = caller and product_id = candidate.product_id;
  if candidate.quantity > purchased - loaded then raise exception 'Insufficient stock'; end if;
  insert into public.loads select (candidate).*;
end;
$$;

create function public.advance_container(target uuid, expected text) returns void
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
  ) then raise exception 'Load stock before recording shipment'; end if;

  update public.containers set status = case current_status when 'preparing' then 'shipped' else 'arrived' end
    where id = target and owner_id = caller;
end;
$$;

revoke all on function public.record_entry(jsonb), public.record_load(jsonb), public.advance_container(uuid, text) from public, anon;
grant execute on function public.record_entry(jsonb), public.record_load(jsonb), public.advance_container(uuid, text) to authenticated;

commit;
