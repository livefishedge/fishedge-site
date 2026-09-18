-- FishEdge application activity, deliberately separate from auth.users.
-- Apply through the Supabase SQL editor/CLI with an operator credential.

create table if not exists public.user_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_presence enable row level security;

-- No direct browser reads/writes. The RPC below derives auth.uid() and uses
-- database time, while service-role/admin reporting can read this table.
revoke all on table public.user_presence from anon, authenticated;

create or replace function public.touch_last_seen()
returns timestamptz
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  current_user_id uuid := auth.uid();
  seen_at timestamptz;
begin
  if current_user_id is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  insert into public.user_presence (user_id, last_seen_at, updated_at)
  values (current_user_id, now(), now())
  on conflict (user_id) do update
    set last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    where public.user_presence.last_seen_at <= now() - interval '5 minutes';

  select last_seen_at into seen_at
    from public.user_presence
   where user_id = current_user_id;
  return seen_at;
end;
$$;

revoke all on function public.touch_last_seen() from public, anon;
grant execute on function public.touch_last_seen() to authenticated;

comment on table public.user_presence is
  'Approximate foreground app activity; not a login or human-attention audit.';
comment on column public.user_presence.last_seen_at is
  'Server timestamp of the latest accepted foreground activity heartbeat.';
