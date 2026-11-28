begin;

-- Optional product translations and statement visibility live alongside the
-- invoice line. Legacy clients must not erase them while editing payments.
create function alsindbad_private.keep_invoice_export_details() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  item jsonb;
  previous_item jsonb;
  updated jsonb := '[]'::jsonb;
  position integer := 0;
begin
  if new.invoice_items is null then return new; end if;
  if jsonb_typeof(new.invoice_items) is distinct from 'array' then
    raise exception 'Invalid invoice items';
  end if;
  for item in select value from jsonb_array_elements(new.invoice_items) loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invalid invoice item'; end if;
    if tg_op = 'UPDATE' then
      previous_item := old.invoice_items->position;
      if item->'name' = previous_item->'name' and item->'unit' = previous_item->'unit' then
        if not (item ? 'name_en') and previous_item ? 'name_en' then
          item := item || jsonb_build_object('name_en', previous_item->'name_en');
        end if;
        if not (item ? 'export_excluded') and previous_item ? 'export_excluded' then
          item := item || jsonb_build_object('export_excluded', previous_item->'export_excluded');
        end if;
      end if;
    end if;
    if item ? 'name_en' then
      if jsonb_typeof(item->'name_en') is distinct from 'string' or char_length(item->>'name_en') > 180 then
        raise exception 'اسم المنتج الإنجليزي غير صحيح / Invalid English product name';
      end if;
      item := item || jsonb_build_object('name_en', btrim(item->>'name_en'));
    end if;
    if item ? 'export_excluded' and jsonb_typeof(item->'export_excluded') is distinct from 'boolean' then
      raise exception 'خيار إظهار المنتج غير صحيح / Invalid statement visibility';
    end if;
    updated := updated || jsonb_build_array(item);
    position := position + 1;
  end loop;
  new.invoice_items := updated;
  return new;
end;
$$;
revoke all on function alsindbad_private.keep_invoice_export_details() from public, anon, authenticated;
create trigger keep_invoice_export_details before insert or update of invoice_items on public.entries
  for each row execute function alsindbad_private.keep_invoice_export_details();
commit;
