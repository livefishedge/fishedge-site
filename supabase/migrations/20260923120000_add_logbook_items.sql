create table if not exists public.logbook_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('waypoint', 'distance', 'trip')),
  title text not null,
  geometry jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists logbook_items_user_kind_idx
  on public.logbook_items(user_id, kind, updated_at desc);

alter table public.logbook_items enable row level security;

create policy logbook_items_owner_read on public.logbook_items
  for select using (auth.uid() = user_id);
create policy logbook_items_owner_insert on public.logbook_items
  for insert with check (auth.uid() = user_id);
create policy logbook_items_owner_update on public.logbook_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy logbook_items_owner_delete on public.logbook_items
  for delete using (auth.uid() = user_id);
