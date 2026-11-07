begin;

alter table public.entries
  add column opening boolean not null default false check (not opening or kind in ('borrow', 'lend')),
  add column revision integer not null default 1 check (revision > 0),
  add column voided_at timestamptz;

create table public.entry_history (
  owner_id uuid not null,
  entry_id uuid not null,
  revision integer not null,
  action text not null check (action in ('correct', 'void')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  previous jsonb not null,
  recorded_at timestamptz not null default now(),
  primary key (owner_id, entry_id, revision),
  foreign key (owner_id, entry_id) references public.entries(owner_id, id)
);
alter table public.entry_history enable row level security;
revoke all on public.entry_history from public, anon, authenticated;
grant select on public.entry_history to authenticated;
create policy read_entry_history on public.entry_history for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));

alter table public.loads add column cost_sar bigint check (cost_sar >= 0);
update public.loads as l
set cost_sar = coalesce((
  select round(sum(round(e.amount * e.rate)) * l.quantity / nullif(sum(e.quantity), 0))
  from public.entries as e
  where e.owner_id = l.owner_id and e.product_id = l.product_id
), 0);
alter table public.loads alter column cost_sar set not null;

-- This helper is private. Its callers hold the workspace's transaction lock.
create function public.assert_entry_candidate(candidate public.entries) returns void
language plpgsql set search_path = ''
as $$
declare
  debt public.entries;
  principal bigint;
  settled bigint;
begin
  if candidate.receipt_path is not null then
    if strpos(candidate.receipt_path, candidate.owner_id::text || '/' || candidate.id::text || '-') <> 1 or not exists (
      select 1 from storage.objects where bucket_id = 'receipts' and name = candidate.receipt_path
    ) then
      raise exception 'Receipt is missing or belongs to a different transaction';
    end if;
  end if;

  if candidate.settles_id is not null then
    select * into debt from public.entries
      where id = candidate.settles_id and owner_id = candidate.owner_id and voided_at is null;
    if not found then raise exception 'Active debt not found'; end if;
    principal := case debt.kind when 'purchase' then debt.amount - debt.paid
      when 'lend' then debt.amount when 'borrow' then debt.amount else 0 end;
    if principal <= 0 or candidate.kind <> (case debt.kind when 'lend' then 'collect' else 'repay' end) then
      raise exception 'Invalid debt settlement';
    end if;
    if candidate.currency <> debt.currency or candidate.party <> debt.party or candidate.scope <> debt.scope then
      raise exception 'Settlement must match the debt currency, party, and scope';
    end if;
    if candidate.date < debt.date then raise exception 'Settlement predates debt'; end if;
    select coalesce(sum(e.amount), 0) into settled from public.entries as e
      where e.owner_id = debt.owner_id and e.settles_id = debt.id and e.voided_at is null and e.id <> candidate.id;
    if candidate.amount > principal - settled then raise exception 'Settlement exceeds outstanding balance'; end if;
  end if;
end;
$$;
revoke all on function public.assert_entry_candidate(public.entries) from public, anon, authenticated;

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

create function public.revise_entry(
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
      container_id = candidate.container_id, opening = candidate.opening, revision = candidate.revision
    where id = target and owner_id = caller;
  end if;
end;
$$;
revoke all on function public.revise_entry(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.revise_entry(uuid, integer, text, jsonb) to authenticated;

create or replace function public.record_load(payload jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  candidate public.loads;
  existing public.loads;
  purchased bigint;
  loaded bigint;
  value_sar numeric;
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
    if (to_jsonb(existing) - 'created_at' - 'cost_sar') = (to_jsonb(candidate) - 'created_at' - 'cost_sar') then return; end if;
    raise exception 'This load was already recorded. Refresh the inventory.' using errcode = '23505';
  end if;
  if not exists (select 1 from public.containers where id = candidate.container_id and owner_id = caller and status = 'preparing') then
    raise exception 'Container is not open';
  end if;
  select coalesce(sum(quantity), 0), coalesce(sum(round(amount * rate)), 0) into purchased, value_sar
    from public.entries where owner_id = caller and product_id = candidate.product_id and voided_at is null;
  select coalesce(sum(quantity), 0) into loaded from public.loads where owner_id = caller and product_id = candidate.product_id;
  if candidate.quantity > purchased - loaded then raise exception 'Insufficient stock'; end if;
  candidate.cost_sar := round(value_sar * candidate.quantity / nullif(purchased, 0));
  insert into public.loads select (candidate).*;
end;
$$;

-- One statement reads balances, stock, and their underlying transactions at a consistent point in time.
create function public.workspace_snapshot() returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select case when public.is_workspace_member() then jsonb_build_object(
    'entries', coalesce((select jsonb_agg(to_jsonb(e) - 'owner_id') from public.entries as e), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(p) - 'owner_id') from public.products as p), '[]'::jsonb),
    'containers', coalesce((select jsonb_agg(to_jsonb(c) - 'owner_id') from public.containers as c), '[]'::jsonb),
    'loads', coalesce((select jsonb_agg(to_jsonb(l) - 'owner_id') from public.loads as l), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(to_jsonb(h) - 'owner_id') from public.entry_history as h), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.workspace_snapshot() from public, anon;
grant execute on function public.workspace_snapshot() to authenticated;

commit;
