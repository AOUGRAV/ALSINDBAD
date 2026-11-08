begin;

create function public.purchase_invoice_total(items jsonb) returns bigint
language plpgsql immutable strict set search_path = ''
as $$
declare
  item jsonb;
  quantity numeric;
  unit_price numeric;
  subtotal numeric := 0;
  total numeric;
begin
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

  total := subtotal + round(subtotal * 0.15);
  if total not between 1 and 100000000000 then
    raise exception 'Invoice total is out of range';
  end if;
  return total::bigint;
end;
$$;
revoke all on function public.purchase_invoice_total(jsonb) from public, anon;
grant execute on function public.purchase_invoice_total(jsonb) to authenticated;

alter table public.entries
  add column invoice_number text,
  add column invoice_items jsonb,
  drop constraint entries_check3,
  add constraint entries_purchase_shape_check check (
    (kind = 'purchase' and product_id is not null and quantity > 0 and invoice_number is null and invoice_items is null)
    or (kind = 'purchase' and product_id is null and quantity = 0 and invoice_number is not null
      and char_length(btrim(invoice_number)) between 1 and 80 and invoice_items is not null)
    or (kind <> 'purchase' and product_id is null and quantity = 0 and invoice_number is null and invoice_items is null)
  ),
  add constraint entries_purchase_invoice_total_check check (
    invoice_items is null or amount = public.purchase_invoice_total(invoice_items)
  );


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
      invoice_number = candidate.invoice_number, invoice_items = candidate.invoice_items
    where id = target and owner_id = caller;
  end if;
end;
$$;
revoke all on function public.revise_entry(uuid, integer, text, jsonb) from public, anon;
grant execute on function public.revise_entry(uuid, integer, text, jsonb) to authenticated;

commit;
