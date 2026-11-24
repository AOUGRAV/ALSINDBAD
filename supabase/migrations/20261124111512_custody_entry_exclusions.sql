begin;

alter table public.entries add column custody_excluded boolean not null default false;

create function alsindbad_private.set_entry_custody_exclusion(target uuid, expected integer, excluded boolean) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  original public.entries;
  change_reason text;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if excluded is null or expected is null or expected < 1 then raise exception 'Invalid custody change'; end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  select * into original from public.entries where id = target and owner_id = caller;
  if not found then raise exception 'Transaction not found'; end if;
  if original.voided_at is not null then raise exception 'الحركة ملغاة / Transaction is voided'; end if;
  if original.custody_excluded = excluded and original.revision in (expected, expected + 1) then return; end if;
  if original.revision <> expected then
    raise exception 'تغيّرت الحركة. حدّث الصفحة / Transaction changed. Refresh the page.';
  end if;
  change_reason := case when excluded then 'استبعاد الحركة من العهدة' else 'إعادة الحركة للعهدة' end;
  insert into public.entry_history(owner_id, entry_id, revision, action, reason, previous)
    values(caller, target, original.revision, 'correct', change_reason, to_jsonb(original) - 'owner_id');
  update public.entries set custody_excluded = excluded, revision = revision + 1 where id = target and owner_id = caller;
end;
$$;
revoke all on function alsindbad_private.set_entry_custody_exclusion(uuid, integer, boolean) from public, anon;
grant execute on function alsindbad_private.set_entry_custody_exclusion(uuid, integer, boolean) to authenticated;

create function public.set_entry_custody_exclusion(target uuid, expected integer, excluded boolean) returns void
language sql security invoker set search_path = ''
as $$ select alsindbad_private.set_entry_custody_exclusion(target, expected, excluded); $$;
revoke all on function public.set_entry_custody_exclusion(uuid, integer, boolean) from public, anon;
grant execute on function public.set_entry_custody_exclusion(uuid, integer, boolean) to authenticated;


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
      paid_outside_custody = candidate.paid_outside_custody, custody_excluded = candidate.custody_excluded
    where id = target and owner_id = caller;
  end if;
end;
$$;
revoke all on function public.revise_entry(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.revise_entry(uuid, integer, text, jsonb) to authenticated;

commit;
