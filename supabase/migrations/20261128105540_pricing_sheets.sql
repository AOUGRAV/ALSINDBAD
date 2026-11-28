create table public.pricing_sheets (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  version uuid not null,
  updated_at timestamptz not null default now(),
  document jsonb not null check (
    pg_column_size(document) <= 1048576 and
    jsonb_typeof(document) = 'object' and
    (document->>'allocation' in ('quantity', 'value')) is true and
    case when jsonb_typeof(document->'items') = 'array' then jsonb_array_length(document->'items') <= 500 else false end and
    case when jsonb_typeof(document->'expenses') = 'array' then jsonb_array_length(document->'expenses') <= 500 else false end
  )
);

create index pricing_sheets_owner_updated_idx on public.pricing_sheets (owner_id, updated_at desc);
alter table public.pricing_sheets enable row level security;
revoke all on public.pricing_sheets from public, anon, authenticated;
grant select on public.pricing_sheets to authenticated;
grant insert (id, name, version, updated_at, document), update (name, version, updated_at, document)
  on public.pricing_sheets to authenticated;

create policy select_own_pricing_sheets on public.pricing_sheets for select to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy insert_own_pricing_sheets on public.pricing_sheets for insert to authenticated
  with check (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
create policy update_own_pricing_sheets on public.pricing_sheets for update to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_workspace_member()))
  with check (owner_id = (select auth.uid()) and (select public.is_workspace_member()));
