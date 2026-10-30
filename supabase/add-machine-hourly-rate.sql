-- Hourly rate ("Kerja jam", RM/jam) moves from the operator to the machine.
-- Used to price Kerja jam work recorded on the machine and for the dashboard's
-- old (hourly) vs new (piece rate) comparison per machine.
--
-- Run this in the Supabase SQL editor BEFORE deploying the build that syncs it
-- (machine upserts include this column; a missing column rejects every push).
--
-- workrecords_operators.hourly_rate is left in place (no longer used by the app)
-- so nothing is lost.
--
-- Idempotent — safe to run more than once.

alter table public.workrecords_machines
  add column if not exists hourly_rate numeric;

notify pgrst, 'reload schema';
