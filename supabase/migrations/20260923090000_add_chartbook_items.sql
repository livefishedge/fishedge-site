create table if not exists public.chartbook_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('waypoint', 'distance', 'trip')),
  title text not null,
  geometry jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists chartbook_items_user_kind_idx
  on public.chartbook_items(user_id, kind, updated_at desc);

alter table public.chartbook_items enable row level security;

create policy chartbook_items_owner_read on public.chartbook_items
  for select using (auth.uid() = user_id);
create policy chartbook_items_owner_insert on public.chartbook_items
  for insert with check (auth.uid() = user_id);
create policy chartbook_items_owner_update on public.chartbook_items
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy chartbook_items_owner_delete on public.chartbook_items
  for delete using (auth.uid() = user_id);
