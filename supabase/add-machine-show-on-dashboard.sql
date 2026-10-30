-- Per-machine "Show on dashboard" tick. Unticked machines are left out of the
-- dashboard charts. Existing machines default to shown.
--
-- Run this in the Supabase SQL editor BEFORE deploying the build that syncs it
-- (machine upserts include this column; a missing column rejects every push).
--
-- Idempotent — safe to run more than once.

alter table public.workrecords_machines
  add column if not exists show_on_dashboard boolean not null default true;

notify pgrst, 'reload schema';
