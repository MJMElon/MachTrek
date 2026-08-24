import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// All tables live in the `public` schema behind a prefix, e.g. workrecords_tasks.
export const SCHEMA = import.meta.env.VITE_SUPABASE_SCHEMA || 'public'
export const TABLE_PREFIX = import.meta.env.VITE_SUPABASE_TABLE_PREFIX ?? 'workrecords_'
// Prefix a base table name to its real Supabase name, e.g. tbl('tasks').
export const tbl = (name) => `${TABLE_PREFIX}${name}`
export const PHOTO_BUCKET = import.meta.env.VITE_SUPABASE_PHOTO_BUCKET || 'photos'

// Sync only turns on when both URL + key are present. Otherwise the app is
// fully usable offline / local-only.
export const supabaseEnabled = Boolean(url && anonKey)

export const supabase = supabaseEnabled
  ? createClient(url, anonKey, {
      db: { schema: SCHEMA },
      auth: { persistSession: true, autoRefreshToken: true },
      global: { headers: { 'x-application-name': 'machinery-piece-rates' } }
    })
  : null

/** Public URL for a photo stored in the bucket (bucket must be public). */
export function publicPhotoUrl(storagePath) {
  if (!supabase || !storagePath) return null
  return supabase.storage.from(PHOTO_BUCKET).getPublicUrl(storagePath).data.publicUrl
}
