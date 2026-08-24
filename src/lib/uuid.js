// Stable client-generated id. Used as the primary key everywhere so records
// can be created offline and keep the same id after they sync to Supabase.
export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // Fallback for very old webviews.
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(16).slice(2, 10)
}
