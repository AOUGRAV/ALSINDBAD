begin;

alter table public.entries drop constraint entries_check5;
alter table public.entries add constraint entries_check5 check (container_id is null or kind = 'expense');

create function alsindbad_private.check_expense_container() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.container_id is not null and not exists (
    select 1 from public.containers where id = new.container_id and owner_id = new.owner_id
  ) then raise exception 'الحاوية غير موجودة / Container not found'; end if;
  return new;
end;
$$;
revoke all on function alsindbad_private.check_expense_container() from public, anon, authenticated;
create trigger check_expense_container before insert or update of container_id, owner_id on public.entries
  for each row execute function alsindbad_private.check_expense_container();

-- Keep the existing manifest RPC available for older clients. The overload saves
-- expense associations and cargo atomically, without changing any cash movements.
create function alsindbad_private.save_container_manifest(payload jsonb, lines jsonb, expected integer, expenses jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  caller uuid := auth.uid();
  target uuid := (payload->>'id')::uuid;
  previous jsonb;
  stored jsonb;
  selected jsonb;
  expense public.entries;
  requested record;
  changed boolean := false;
begin
  if caller is null or not public.is_workspace_member() then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(caller::text, 0));
  if target is null or jsonb_typeof(expenses->'selected') is distinct from 'array'
    or jsonb_typeof(expenses->'previous') is distinct from 'array' then
    raise exception 'بيانات المصاريف غير صحيحة / Invalid expenses';
  end if;
  for requested in select value from jsonb_array_elements(expenses->'selected')
    union all select value from jsonb_array_elements(expenses->'previous') loop
    if (requested.value->>'id')::uuid is null or (requested.value->>'revision')::integer is null
      or (requested.value->>'revision')::integer < 1 then
      raise exception 'بيانات المصروف غير صحيحة / Invalid expense';
    end if;
  end loop;
  if exists (select 1 from jsonb_to_recordset(expenses->'selected') as x(id uuid) group by id having count(*) > 1)
    or exists (select 1 from jsonb_to_recordset(expenses->'previous') as x(id uuid) group by id having count(*) > 1) then
    raise exception 'مصروف مكرر / Duplicate expense';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by id), '[]') into previous
    from jsonb_to_recordset(expenses->'previous') as x(id uuid, revision integer);
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'revision', revision) order by id), '[]') into stored
    from public.entries where owner_id = caller and container_id = target and kind = 'expense' and voided_at is null;
  if previous is distinct from stored then
    raise exception 'تغيّرت مصاريف الحاوية. حدّث البيانات / Container expenses changed. Refresh the records.';
  end if;
  selected := expenses->'selected';
  for requested in select * from jsonb_to_recordset(selected) as x(id uuid, revision integer) loop
    select * into expense from public.entries where id = requested.id and owner_id = caller
      and kind = 'expense' and voided_at is null;
    if not found or expense.revision is distinct from requested.revision
      or (expense.container_id is not null and expense.container_id <> target) then
      raise exception 'تغيّر المصروف أو ارتبط بحاوية أخرى. حدّث البيانات / Expense changed or belongs to another container. Refresh the records.';
    end if;
  end loop;
  perform alsindbad_private.save_container_manifest(payload, lines, expected);
  for expense in select * from public.entries where owner_id = caller and kind = 'expense' and voided_at is null
    and container_id = target and not exists (select 1 from jsonb_to_recordset(selected) as x(id uuid) where x.id = entries.id) loop
    perform public.revise_entry(expense.id, expense.revision, 'فك ارتباط المصروف بالحاوية / Unlink container expense', jsonb_build_object('container_id', null));
    changed := true;
  end loop;
  for expense in select * from public.entries where owner_id = caller and kind = 'expense' and voided_at is null
    and container_id is null and exists (select 1 from jsonb_to_recordset(selected) as x(id uuid) where x.id = entries.id) loop
    perform public.revise_entry(expense.id, expense.revision, 'ربط المصروف بالحاوية / Link container expense', jsonb_build_object('container_id', target));
    changed := true;
  end loop;
  if changed then update public.containers set manifest_revision = manifest_revision + 1 where id = target and owner_id = caller; end if;
end;
$$;
revoke all on function alsindbad_private.save_container_manifest(jsonb, jsonb, integer, jsonb) from public, anon;
grant execute on function alsindbad_private.save_container_manifest(jsonb, jsonb, integer, jsonb) to authenticated;
create function public.save_container_with_expenses(payload jsonb, lines jsonb, expected integer, expenses jsonb)
returns void language sql security invoker set search_path = '' as $$
  select alsindbad_private.save_container_manifest(payload, lines, expected, expenses);
$$;
revoke all on function public.save_container_with_expenses(jsonb, jsonb, integer, jsonb) from public, anon;
grant execute on function public.save_container_with_expenses(jsonb, jsonb, integer, jsonb) to authenticated;
commit;
