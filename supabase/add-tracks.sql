-- GPS distance tracks: recordings made by operators on the map while finishing
-- a meter-unit piece-rate task. Points are stored as jsonb [{lat,lng,t}].
--
-- Run this in the Supabase SQL editor BEFORE deploying the app build that
-- syncs tracks (the sync engine upserts into workrecords_tracks; a missing
-- table breaks every sync run).
--
-- Idempotent — safe to run more than once.

create table if not exists public.workrecords_tracks (
  id uuid primary key,
  operator_id uuid,
  operator_name text,
  task_id uuid,
  piece_rate_id uuid,
  piece_rate_name text,
  company_id uuid,
  points jsonb not null default '[]'::jsonb,
  distance_meters double precision not null default 0,
  started_at timestamptz,
  ended_at timestamptz,
  day_key text,
  month_key text,
  deleted boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists workrecords_tracks_updated_idx on public.workrecords_tracks (updated_at);
create index if not exists workrecords_tracks_operator_month_idx on public.workrecords_tracks (operator_id, month_key);

grant all on public.workrecords_tracks to anon, authenticated;

alter table public.workrecords_tracks enable row level security;
drop policy if exists "app_all" on public.workrecords_tracks;
create policy "app_all" on public.workrecords_tracks
  for all to anon, authenticated using (true) with check (true);

-- Let PostgREST pick up the new table immediately.
notify pgrst, 'reload schema';
