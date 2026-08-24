-- ============================================================================
-- Machinery Piece Rates — Supabase schema
-- Run this in: Supabase dashboard -> SQL Editor -> New query -> Run
--
-- AFTER running, you MUST expose the schema to the API:
--   Dashboard -> Project Settings -> API -> "Exposed schemas"
--   add:  machinery-piecerate   (then Save)
-- ============================================================================

create schema if not exists "machinery-piecerate";

-- Let the API roles use the schema.
grant usage on schema "machinery-piecerate" to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Operators are the login accounts (name + PIN). machine_ids = the machines
-- the admin lets them use.
create table if not exists "machinery-piecerate".operators (
  id uuid primary key,
  name text not null,
  company_id uuid,
  pin text,
  pin_hash text,
  active boolean not null default true,
  is_site_admin boolean not null default false,
  basic_salary numeric,
  phone_allowance numeric,
  hourly_rate numeric,
  machine_ids jsonb not null default '[]'::jsonb,
  force_logout_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Piece rates belong to a machine.
create table if not exists "machinery-piecerate".piece_rates (
  id uuid primary key,
  machine_id uuid,
  name text not null,
  unit text,
  price numeric not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Areas belong to a company (a per-company land category).
create table if not exists "machinery-piecerate".areas (
  id uuid primary key,
  company_id uuid,
  name text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists "machinery-piecerate".companies (
  id uuid primary key,
  name text not null,
  active boolean not null default true,
  signers jsonb,
  updated_at timestamptz not null default now()
);

-- A machine belongs to a company and carries the login PIN (hashed).
create table if not exists "machinery-piecerate".machines (
  id uuid primary key,
  company_id uuid,
  name text not null,
  pin_hash text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists "machinery-piecerate".tasks (
  id uuid primary key,
  company_id uuid,
  company_name text,
  machine_id uuid,
  machine_name text,
  operator_id uuid,
  operator_name text,
  status text not null default 'in_progress',
  created_by text not null default 'operator',

  start_mileage numeric,
  start_time timestamptz,
  start_lat double precision,
  start_lng double precision,
  start_gps_source text,
  start_photo_id uuid,
  work_photo_id uuid,

  end_mileage numeric,
  end_time timestamptz,
  end_lat double precision,
  end_lng double precision,
  end_gps_source text,
  end_work_photo_id uuid,
  end_photo_id uuid,

  duration_minutes integer,

  piece_rate_id uuid,
  piece_rate_name text,
  unit text,
  unit_price numeric,
  quantity numeric,
  quantity_expr text,
  amount numeric,

  area_id uuid,
  area_name text,

  notes text,
  day_key text,
  month_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Per-operator, per-month claim-form extras (Bahagian B incentives), saved so
-- an admin can fill them ahead and they persist for that operator + month.
create table if not exists "machinery-piecerate".claims (
  id text primary key,
  operator_id uuid,
  month_key text,
  incentives jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- Per-month payroll lock. A locked month's records + payroll cannot be changed
-- until an admin unlocks it. id = the monthKey ("YYYY-MM").
create table if not exists "machinery-piecerate".month_locks (
  id text primary key,
  locked boolean not null default false,
  locked_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists "machinery-piecerate".photos (
  id uuid primary key,
  task_id uuid references "machinery-piecerate".tasks (id) on delete cascade,
  kind text,
  storage_path text,
  captured_at timestamptz,
  lat double precision,
  lng double precision,
  gps_source text,
  updated_at timestamptz not null default now()
);

-- If tables already existed from an earlier version, add the new columns.
alter table "machinery-piecerate".tasks add column if not exists company_id uuid;
alter table "machinery-piecerate".tasks add column if not exists company_name text;
alter table "machinery-piecerate".tasks add column if not exists machine_id uuid;
alter table "machinery-piecerate".tasks add column if not exists machine_name text;
alter table "machinery-piecerate".tasks add column if not exists quantity_expr text;
alter table "machinery-piecerate".piece_rates add column if not exists machine_id uuid;
alter table "machinery-piecerate".operators add column if not exists machine_ids jsonb not null default '[]'::jsonb;
alter table "machinery-piecerate".operators add column if not exists company_id uuid;
alter table "machinery-piecerate".operators add column if not exists force_logout_at timestamptz;
alter table "machinery-piecerate".operators add column if not exists pin text;
alter table "machinery-piecerate".operators add column if not exists is_site_admin boolean not null default false;
alter table "machinery-piecerate".operators add column if not exists basic_salary numeric;
alter table "machinery-piecerate".operators add column if not exists phone_allowance numeric;
alter table "machinery-piecerate".operators add column if not exists hourly_rate numeric;
alter table "machinery-piecerate".areas add column if not exists company_id uuid;
alter table "machinery-piecerate".companies add column if not exists signers jsonb;

-- Soft-delete flag: deleting a row sets deleted = true + bumps updated_at so the
-- removal propagates to other devices via the normal pull (a hard delete would
-- vanish silently and leave stale copies on other devices).
alter table "machinery-piecerate".companies add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".machines add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".operators add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".piece_rates add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".areas add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".tasks add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".photos add column if not exists deleted boolean not null default false;
alter table "machinery-piecerate".claims add column if not exists deleted boolean not null default false;

-- Indexes that match how the app queries / pulls (by updated_at cursor).
create index if not exists tasks_month_key_idx on "machinery-piecerate".tasks (month_key);
create index if not exists tasks_company_idx on "machinery-piecerate".tasks (company_id);
create index if not exists tasks_operator_idx on "machinery-piecerate".tasks (operator_id);
create index if not exists tasks_updated_idx on "machinery-piecerate".tasks (updated_at);
create index if not exists photos_task_idx on "machinery-piecerate".photos (task_id);
create index if not exists photos_updated_idx on "machinery-piecerate".photos (updated_at);
create index if not exists companies_updated_idx on "machinery-piecerate".companies (updated_at);
create index if not exists machines_updated_idx on "machinery-piecerate".machines (updated_at);
create index if not exists machines_company_idx on "machinery-piecerate".machines (company_id);
create index if not exists piece_rates_updated_idx on "machinery-piecerate".piece_rates (updated_at);
create index if not exists piece_rates_machine_idx on "machinery-piecerate".piece_rates (machine_id);
create index if not exists operators_updated_idx on "machinery-piecerate".operators (updated_at);
create index if not exists areas_updated_idx on "machinery-piecerate".areas (updated_at);
create index if not exists claims_updated_idx on "machinery-piecerate".claims (updated_at);
create index if not exists claims_operator_month_idx on "machinery-piecerate".claims (operator_id, month_key);
create index if not exists month_locks_updated_idx on "machinery-piecerate".month_locks (updated_at);

-- ---------------------------------------------------------------------------
-- Privileges (PostgREST needs explicit grants on the tables)
-- ---------------------------------------------------------------------------
grant all on all tables in schema "machinery-piecerate" to anon, authenticated, service_role;
alter default privileges in schema "machinery-piecerate"
  grant all on tables to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- ⚠️  IMPORTANT: the app currently authenticates LOCALLY (PIN / password) and
-- talks to Supabase with the public ANON key. The policies below therefore
-- allow the anon role full access — meaning ANYONE with your project URL +
-- anon key can read/write this data. That is acceptable for a small private
-- pilot, but for real production you should switch to Supabase Auth and tighten
-- these policies (e.g. per-operator row ownership). See README "Hardening".
-- ---------------------------------------------------------------------------
alter table "machinery-piecerate".companies   enable row level security;
alter table "machinery-piecerate".machines    enable row level security;
alter table "machinery-piecerate".operators   enable row level security;
alter table "machinery-piecerate".piece_rates enable row level security;
alter table "machinery-piecerate".areas       enable row level security;
alter table "machinery-piecerate".claims      enable row level security;
alter table "machinery-piecerate".month_locks enable row level security;
alter table "machinery-piecerate".tasks       enable row level security;
alter table "machinery-piecerate".photos      enable row level security;

do $$
declare t text;
begin
  foreach t in array array['companies','machines','operators','piece_rates','areas','claims','month_locks','tasks','photos'] loop
    execute format('drop policy if exists "app_all" on "machinery-piecerate".%I;', t);
    execute format(
      'create policy "app_all" on "machinery-piecerate".%I for all to anon, authenticated using (true) with check (true);',
      t
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: bucket for work photos (public read so synced devices can show them)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = true;

-- Allow the app (anon) to upload / overwrite / delete objects in this bucket.
-- Public read is already granted by the bucket being public.
drop policy if exists "photos_anon_insert" on storage.objects;
create policy "photos_anon_insert" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'photos');

drop policy if exists "photos_anon_update" on storage.objects;
create policy "photos_anon_update" on storage.objects
  for update to anon, authenticated
  using (bucket_id = 'photos') with check (bucket_id = 'photos');

drop policy if exists "photos_anon_delete" on storage.objects;
create policy "photos_anon_delete" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'photos');

drop policy if exists "photos_anon_select" on storage.objects;
create policy "photos_anon_select" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'photos');

-- ---------------------------------------------------------------------------
-- Retention: keep ~3 years (36 months) of records + payroll, judged by the
-- WORK / payroll month (month_key), NOT the row's edit date. Older data is
-- removed to save space. The client purges on startup (and removes the photo
-- files), but this server-side job is a safety net that also runs unattended.
-- ---------------------------------------------------------------------------
create or replace function "machinery-piecerate".purge_old_data()
returns void
language plpgsql
as $fn$
declare
  cutoff text := to_char((now() - interval '35 months'), 'YYYY-MM'); -- keep 36 months incl. current
begin
  -- Remove the photo FILES for old tasks first (free Storage), then their rows.
  delete from storage.objects o
    using "machinery-piecerate".photos p, "machinery-piecerate".tasks t
    where o.bucket_id = 'photos' and o.name = p.storage_path
      and p.task_id = t.id and coalesce(t.month_key, '') < cutoff;
  delete from "machinery-piecerate".photos p
    using "machinery-piecerate".tasks t
    where p.task_id = t.id and coalesce(t.month_key, '') < cutoff;
  delete from "machinery-piecerate".tasks  where coalesce(month_key, '') < cutoff;
  delete from "machinery-piecerate".claims where coalesce(month_key, '') < cutoff;
end
$fn$;

-- Run it daily if pg_cron is available; ignored (with a notice) if it is not.
do $$
begin
  perform cron.schedule(
    'machinery-purge-old',
    '17 3 * * *',
    'select "machinery-piecerate".purge_old_data();'
  );
exception when others then
  raise notice 'pg_cron unavailable — scheduled purge skipped; the app purges on startup instead.';
end $$;

-- Tell PostgREST to reload so the new schema/tables are picked up.
notify pgrst, 'reload schema';

-- ============================================================================
-- Done. Remember: Settings -> API -> Exposed schemas -> add machinery-piecerate
-- ============================================================================
