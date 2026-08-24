-- Company boundary: an estate/site outline uploaded by the HQ admin as a KML or
-- GPX file, parsed client-side into simple shapes and drawn as a background
-- layer on every map for that company.
--
-- Stored as jsonb: { name, features: [{ type: 'polygon'|'line', coords: [[lat,lng], ...] }] }
--
-- Run this in the Supabase SQL editor BEFORE deploying the build that syncs
-- boundaries (company upserts include this column; a missing column rejects
-- every company push).
--
-- Idempotent — safe to run more than once.

alter table public.workrecords_companies
  add column if not exists boundary jsonb;

notify pgrst, 'reload schema';
