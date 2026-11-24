begin;

alter table public.entries add column notes text check (notes is null or char_length(notes) <= 2000);

create table public.debt_account_notes (
  owner_id uuid not null references auth.users(id),
  party_key text not null check (char_length(party_key) between 1 and 120 and party_key = lower(btrim(party_key))),
  notes text not null default '' check (char_length(notes) <= 2000),
  revision integer not null default 1 check (revision > 0),
  primary key (owner_id, party_key)
);
alter table public.debt_account_notes enable row level security;
create policy read_account_notes on public.debt_account_notes for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
revoke all on public.debt_account_notes from anon, authenticated;
grant select on public.debt_account_notes to authenticated;

create table public.cash_transfers (
  id uuid primary key,
  owner_id uuid not null references auth.users(id),
  date date not null,
  amount bigint not null check (amount between 1 and 100000000000),
  currency text not null check (currency in ('SAR', 'USD', 'GBP', 'EUR')),
  rate numeric not null check (rate > 0 and rate <= 10000 and rate = round(rate, 6) and (currency <> 'SAR' or rate = 1)),
  from_account text not null check (from_account in ('cash', 'bank')),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  revision integer not null default 1 check (revision > 0),
  voided_at timestamptz
);
create index cash_transfers_owner_date on public.cash_transfers(owner_id, date);
alter table public.cash_transfers enable row level security;
create policy read_cash_transfers on public.cash_transfers for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
revoke all on public.cash_transfers from anon, authenticated;
grant select on public.cash_transfers to authenticated;

create function alsindbad_private.save_account_note(party text, note text, expected integer) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  key text := lower(btrim(party));
  current_note public.debt_account_notes;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if key is null or char_length(key) not between 1 and 120 or note is null or char_length(note) > 2000
    or expected is null or expected < 0 then
    raise exception 'ملاحظات الحساب غير صحيحة / Invalid account notes';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select * into current_note from public.debt_account_notes where owner_id = caller and party_key = key;
  if found then
    if current_note.notes = btrim(note) and current_note.revision in (expected, expected + 1) then return; end if;
    if current_note.revision <> expected then
      raise exception 'تغيّرت الملاحظات. حدّث الصفحة قبل الحفظ / Notes changed. Refresh before saving.';
    end if;
    update public.debt_account_notes set notes = btrim(note), revision = revision + 1
      where owner_id = caller and party_key = key;
  else
    if expected <> 0 then raise exception 'تغيّر الحساب. حدّث الصفحة / Account changed. Refresh the page.'; end if;
    if not exists (select 1 from public.entries e where e.owner_id = caller and lower(btrim(e.party)) = key and e.voided_at is null
      and (e.kind in ('borrow', 'lend') or e.settles_id is not null or (e.kind = 'purchase' and e.amount > e.paid))) then
      raise exception 'حساب الدين غير موجود / Debt account not found';
    end if;
    insert into public.debt_account_notes(owner_id, party_key, notes) values (caller, key, btrim(note));
  end if;
end;
$$;
revoke all on function alsindbad_private.save_account_note(text, text, integer) from public, anon;
grant execute on function alsindbad_private.save_account_note(text, text, integer) to authenticated;
create function public.save_account_note(party text, note text, expected integer) returns void
language sql security invoker set search_path = ''
as $$ select alsindbad_private.save_account_note(party, note, expected); $$;
revoke all on function public.save_account_note(text, text, integer) from public, anon;
grant execute on function public.save_account_note(text, text, integer) to authenticated;

create function alsindbad_private.save_cash_transfer(payload jsonb, expected integer, remove boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  original public.cash_transfers;
  candidate public.cash_transfers;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if expected is null or expected < 0 or remove is null or jsonb_typeof(payload) is distinct from 'object' then
    raise exception 'بيانات التحويل غير صحيحة / Invalid transfer';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  candidate := jsonb_populate_record(null::public.cash_transfers, payload);
  candidate.owner_id := caller;
  candidate.notes := btrim(coalesce(candidate.notes, ''));
  candidate.created_at := now();
  candidate.voided_at := null;
  candidate.revision := 1;
  select * into original from public.cash_transfers where id = candidate.id and owner_id = caller;
  if found then
    if remove and original.voided_at is not null and original.revision = expected + 1 then return; end if;
    if not remove and original.voided_at is null and original.revision in (expected, expected + 1) and
      (to_jsonb(original) - 'revision' - 'created_at') = (to_jsonb(candidate) - 'revision' - 'created_at') then return; end if;
    if original.voided_at is not null or original.revision <> expected then
      raise exception 'تغيّر التحويل. حدّث الصفحة قبل الحفظ / Transfer changed. Refresh before saving.';
    end if;
    if remove then
      update public.cash_transfers set voided_at = now(), revision = revision + 1 where id = original.id and owner_id = caller;
    else
      update public.cash_transfers set date = candidate.date, amount = candidate.amount, currency = candidate.currency,
        rate = candidate.rate, from_account = candidate.from_account, notes = candidate.notes, revision = revision + 1
        where id = original.id and owner_id = caller;
    end if;
  else
    if expected <> 0 or remove then raise exception 'التحويل غير موجود / Transfer not found'; end if;
    insert into public.cash_transfers select (candidate).*;
  end if;
end;
$$;
revoke all on function alsindbad_private.save_cash_transfer(jsonb, integer, boolean) from public, anon;
grant execute on function alsindbad_private.save_cash_transfer(jsonb, integer, boolean) to authenticated;
create function public.save_cash_transfer(payload jsonb, expected integer, remove boolean default false) returns void
language sql security invoker set search_path = ''
as $$ select alsindbad_private.save_cash_transfer(payload, expected, remove); $$;
revoke all on function public.save_cash_transfer(jsonb, integer, boolean) from public, anon;
grant execute on function public.save_cash_transfer(jsonb, integer, boolean) to authenticated;

create or replace function public.workspace_snapshot() returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select case when public.is_workspace_member() then jsonb_build_object(
    'entries', coalesce((select jsonb_agg(to_jsonb(e) - 'owner_id') from public.entries e), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(to_jsonb(p) - 'owner_id') from public.products p), '[]'::jsonb),
    'containers', coalesce((select jsonb_agg(to_jsonb(c) - 'owner_id') from public.containers c), '[]'::jsonb),
    'loads', coalesce((select jsonb_agg(to_jsonb(l) - 'owner_id') from public.loads l), '[]'::jsonb),
    'invoice_loads', coalesce((select jsonb_agg(to_jsonb(l) - 'owner_id' - 'included') from public.container_invoice_loads l where l.included), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(to_jsonb(h) - 'owner_id') from public.entry_history h), '[]'::jsonb),
    'account_notes', coalesce((select jsonb_agg(to_jsonb(n) - 'owner_id') from public.debt_account_notes n), '[]'::jsonb),
    'cash_transfers', coalesce((select jsonb_agg(to_jsonb(t) - 'owner_id') from public.cash_transfers t), '[]'::jsonb)
  ) end;
$$;
revoke all on function public.workspace_snapshot() from public, anon;
grant execute on function public.workspace_snapshot() to authenticated;


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
      invoice_number = candidate.invoice_number, invoice_items = candidate.invoice_items, notes = candidate.notes
    where id = target and owner_id = caller;
  end if;
end;
$$;
revoke all on function public.revise_entry(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.revise_entry(uuid, integer, text, jsonb) to authenticated;

commit;
