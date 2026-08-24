-- ============================================================================
-- Move the app's tables OUT of the "machinery-piecerate" schema INTO public,
-- renamed with a  workrecords_  prefix (e.g. workrecords_tasks).
--
-- This MOVES the tables (not a copy): data, indexes, primary/foreign keys and
-- RLS policies all move with them. Run once in Supabase -> SQL Editor -> Run.
-- Reversible: to undo, move each table back and drop the prefix.
-- ============================================================================

-- 1. Rename each table in place, then move it to public.
do $$
declare t text;
begin
  foreach t in array array[
    'companies','machines','operators','piece_rates','areas',
    'tasks','photos','claims','month_locks'
  ] loop
    if exists (
      select 1 from information_schema.tables
      where table_schema = 'machinery-piecerate' and table_name = t
    ) then
      execute format('alter table "machinery-piecerate".%I rename to %I;', t, 'workrecords_' || t);
      execute format('alter table "machinery-piecerate".%I set schema public;', 'workrecords_' || t);
    end if;
  end loop;
end $$;

-- 2. Grants + Row Level Security on the moved tables (PostgREST + the anon key
--    need these; same open-to-anon posture as before).
do $$
declare t text;
begin
  foreach t in array array[
    'workrecords_companies','workrecords_machines','workrecords_operators',
    'workrecords_piece_rates','workrecords_areas','workrecords_tasks',
    'workrecords_photos','workrecords_claims','workrecords_month_locks'
  ] loop
    execute format('grant all on public.%I to anon, authenticated, service_role;', t);
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "app_all" on public.%I;', t);
    execute format('create policy "app_all" on public.%I for all to anon, authenticated using (true) with check (true);', t);
  end loop;
end $$;

-- 3. Reload PostgREST so the API sees the moved tables.
notify pgrst, 'reload schema';

-- ----------------------------------------------------------------------------
-- OPTIONAL: recreate the nightly server-side purge for the new tables and stop
-- the old one (the client also purges locally, so this is just a safety net).
-- ----------------------------------------------------------------------------
create or replace function public.workrecords_purge_old_data()
returns void language plpgsql as $fn$
declare cutoff text := to_char((now() - interval '35 months'), 'YYYY-MM'); -- keep 36 months
begin
  delete from storage.objects o
    using public.workrecords_photos p, public.workrecords_tasks t
    where o.bucket_id = 'photos' and o.name = p.storage_path
      and p.task_id = t.id and coalesce(t.month_key, '') < cutoff;
  delete from public.workrecords_photos p using public.workrecords_tasks t
    where p.task_id = t.id and coalesce(t.month_key, '') < cutoff;
  delete from public.workrecords_tasks  where coalesce(month_key, '') < cutoff;
  delete from public.workrecords_claims where coalesce(month_key, '') < cutoff;
end $fn$;

do $$ begin perform cron.unschedule('machinery-purge-old'); exception when others then null; end $$;
do $$ begin
  perform cron.schedule('workrecords-purge-old', '17 3 * * *', 'select public.workrecords_purge_old_data();');
exception when others then
  raise notice 'pg_cron unavailable — the app still purges on startup.';
end $$;

-- ============================================================================
-- Done. The old "machinery-piecerate" schema is now empty (you can drop it
-- later once you've confirmed everything works):
--   drop schema "machinery-piecerate" cascade;
-- Note: the "public" schema is exposed to the API by default — no "Exposed
-- schemas" step needed. The photos storage bucket is unchanged.
-- ============================================================================
