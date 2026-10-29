-- Monthly diesel subsidy preset on an operator ("Subsidi diesel" row in
-- Bahagian A of the claim form, included in payroll like the phone allowance).
--
-- Run this in the Supabase SQL editor BEFORE deploying the build that syncs it
-- (operator upserts include this column; a missing column rejects every push).
--
-- Idempotent — safe to run more than once.

alter table public.workrecords_operators
  add column if not exists diesel_subsidy numeric;

notify pgrst, 'reload schema';
