// Local-only secret hashing for the offline PIN / password gate.
//
// SECURITY NOTE: this protects access on the device when offline. It is a
// usability gate, not server-grade auth. Real authorisation for the synced
// data should be enforced by Supabase Row Level Security + Supabase Auth.
// crypto.subtle requires a secure context (https or localhost) — PWAs run on
// https, so this is always available in production.

const SALT = 'mpr.v1.local-gate'

/** SHA-256 hex of a salted value. */
export async function hashSecret(value) {
  const data = new TextEncoder().encode(`${SALT}:${value}`)
  const buf = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time-ish compare of a value against a stored hash. */
export async function verifySecret(value, hash) {
  if (!hash) return false
  const h = await hashSecret(value)
  return timingSafeEqual(h, hash)
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

/** Human-friendly recovery code, e.g. "K7P3-Q9MX-2RTB" (no ambiguous chars). */
export function randomCode(groups = 3, perGroup = 4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const out = []
  for (let g = 0; g < groups; g++) {
    const arr = new Uint8Array(perGroup)
    crypto.getRandomValues(arr)
    out.push([...arr].map((x) => alphabet[x % alphabet.length]).join(''))
  }
  return out.join('-')
}
