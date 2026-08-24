-- Adds the proof-of-work photo taken at task completion.
-- The claim/records flow now stores TWO end photos: a proof-of-work photo
-- (end_work_photo_id) and the ending meter photo (existing end_photo_id).
--
-- Safe to run more than once. Existing rows get NULL (no proof photo on record).
-- Run this BEFORE deploying the app build that writes end_work_photo_id.

alter table public.workrecords_tasks
  add column if not exists end_work_photo_id uuid;

-- Let PostgREST pick up the new column immediately.
notify pgrst, 'reload schema';
