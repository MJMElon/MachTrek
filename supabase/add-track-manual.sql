-- Marks a path that an HQ admin DREW on the map instead of one an operator
-- recorded with GPS. Kept explicit so payroll/audit can tell them apart.
--
-- Run this in the Supabase SQL editor BEFORE deploying the build that syncs it
-- (track upserts include this column; a missing column rejects every push).
--
-- Idempotent — safe to run more than once.

alter table public.workrecords_tracks
  add column if not exists manual boolean not null default false;

-- Who drew it ("HQ admin" / "Site admin"), shown on the path's detail panel.
alter table public.workrecords_tracks
  add column if not exists drawn_by text;

-- Set when an HQ admin reshapes a GPS-RECORDED path, so an audit can see the
-- recording was altered by hand.
alter table public.workrecords_tracks
  add column if not exists edited_by text;

notify pgrst, 'reload schema';
