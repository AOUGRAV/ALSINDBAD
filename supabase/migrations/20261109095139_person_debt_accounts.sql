begin;

alter table public.entries
  add column debt_movement_id uuid check (debt_movement_id is null or kind in ('borrow', 'lend', 'collect', 'repay'));
create index entries_owner_debt_movement on public.entries(owner_id, debt_movement_id) where debt_movement_id is not null;
create index entries_owner_debt_account on public.entries(owner_id, lower(btrim(party)), currency, scope, date)
  where voided_at is null and kind in ('borrow', 'lend', 'purchase');

create function alsindbad_private.record_debt_movement(payload jsonb, expected_allocations jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  movement public.entries;
  direction text := payload->>'direction';
  separate boolean := coalesce((payload->>'separate')::boolean, false);
  principal_kind text;
  settlement_kind text;
  actual_allocations jsonb := '[]'::jsonb;
  stored_amount bigint;
  same_movement boolean;
  remaining bigint;
  allocation record;
  debt public.entries;
  line_id uuid;
  common jsonb;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  movement := jsonb_populate_record(null::public.entries, payload);
  movement.party := btrim(movement.party);
  movement.opening := coalesce(movement.opening, false);
  if movement.id is null or movement.date is null or movement.amount is null or movement.amount not between 1 and 100000000000
    or movement.party is null or char_length(movement.party) not between 1 and 120
    or direction is null or direction not in ('take', 'give') or jsonb_typeof(expected_allocations) is distinct from 'array'
  then raise exception 'بيانات الحركة غير صحيحة / Invalid movement'; end if;
  principal_kind := case direction when 'take' then 'borrow' else 'lend' end;
  settlement_kind := case direction when 'take' then 'collect' else 'repay' end;

  select sum(e.amount), bool_and(e.voided_at is null and e.kind in (principal_kind, settlement_kind)
    and lower(btrim(e.party)) = lower(movement.party) and e.date = movement.date and e.currency = movement.currency
    and e.scope = movement.scope and e.rate = movement.rate and e.method = movement.method
    and e.description = movement.description and e.opening = movement.opening)
  into stored_amount, same_movement
  from public.entries e where e.owner_id = caller and e.debt_movement_id = movement.id;
  if stored_amount is not null then
    if same_movement and stored_amount = movement.amount then return; end if;
    raise exception 'الحركة مسجلة مسبقًا. حدّث السجل / Movement already recorded. Refresh the records.';
  end if;

  if not separate and not movement.opening then
    with available as (
      select e.id, e.date, e.created_at,
        (case e.kind when 'purchase' then e.amount - e.paid else e.amount end) - paid.amount as balance
      from public.entries e
      cross join lateral (
        select coalesce(sum(p.amount), 0) as amount from public.entries p
        where p.owner_id = caller and p.settles_id = e.id and p.voided_at is null
      ) as paid
      where e.owner_id = caller and e.voided_at is null and e.kind in ('borrow', 'lend', 'purchase')
        and lower(btrim(e.party)) = lower(movement.party) and e.currency = movement.currency and e.scope = movement.scope
        and e.date <= movement.date and ((direction = 'take' and e.kind = 'lend') or (direction = 'give' and e.kind in ('borrow', 'purchase')))
    ), ordered as (
      select *, coalesce(sum(balance) over (order by date, created_at, id rows between unbounded preceding and 1 preceding), 0) as earlier
      from available where balance > 0
    )
    select coalesce(jsonb_agg(jsonb_build_object('debt_id', id, 'amount', least(balance, movement.amount - earlier))
      order by date, created_at, id), '[]'::jsonb)
    into actual_allocations from ordered where earlier < movement.amount;
  end if;
  if expected_allocations <> actual_allocations then
    raise exception 'تغيّر الرصيد. حدّث البيانات قبل الحفظ / Balance changed. Refresh before saving.';
  end if;

  common := jsonb_build_object('date', movement.date, 'description', movement.description, 'scope', movement.scope,
    'currency', movement.currency, 'rate', movement.rate, 'method', movement.method,
    'quantity', 0, 'debt_movement_id', movement.id);
  remaining := movement.amount;
  line_id := movement.id;
  for allocation in select * from jsonb_to_recordset(actual_allocations) as l(debt_id uuid, amount bigint) loop
    select * into debt from public.entries where owner_id = caller and id = allocation.debt_id;
    perform public.record_entry(common || jsonb_build_object('id', line_id, 'kind', settlement_kind, 'party', debt.party,
      'category', debt.category, 'amount', allocation.amount, 'paid', allocation.amount, 'settles_id', debt.id,
      'receipt_path', case when line_id = movement.id then movement.receipt_path end));
    remaining := remaining - allocation.amount;
    line_id := gen_random_uuid();
  end loop;
  if remaining > 0 then
    perform public.record_entry(common || jsonb_build_object('id', line_id, 'kind', principal_kind, 'party', movement.party,
      'category', movement.category, 'amount', remaining, 'paid', remaining, 'opening', movement.opening,
      'receipt_path', case when line_id = movement.id then movement.receipt_path end));
  end if;
end;
$$;
revoke all on function alsindbad_private.record_debt_movement(jsonb, jsonb) from public, anon;
grant execute on function alsindbad_private.record_debt_movement(jsonb, jsonb) to authenticated;

create function public.record_debt_movement(payload jsonb, expected_allocations jsonb) returns void
language sql security invoker set search_path = ''
as $$
  select alsindbad_private.record_debt_movement(payload, expected_allocations);
$$;
revoke all on function public.record_debt_movement(jsonb, jsonb) from public, anon;
grant execute on function public.record_debt_movement(jsonb, jsonb) to authenticated;

commit;
