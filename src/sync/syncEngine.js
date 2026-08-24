// Offline-first sync engine.
//
// Writes always land in IndexedDB first (see repo.js) with syncStatus
// 'pending'. This engine pushes pending rows + photo blobs to Supabase when
// online, then pulls presets and other-device records back down. It is safe to
// call requestSync() liberally — runs are serialised and debounced.

import { supabase, supabaseEnabled, PHOTO_BUCKET, tbl } from './supabase.js'
import { db, getMeta, setMeta } from '../db/database.js'
import { onChange } from './bus.js'
import { SyncStatus } from '../db/models.js'
import {
  toServerTask,
  fromServerTask,
  toServerPhoto,
  fromServerPhoto,
  toServerCompany,
  fromServerCompany,
  toServerMachine,
  fromServerMachine,
  toServerOperator,
  fromServerOperator,
  toServerPieceRate,
  fromServerPieceRate,
  toServerArea,
  fromServerArea,
  toServerClaim,
  fromServerClaim,
  toServerMonthLock,
  fromServerMonthLock,
  toServerTrack,
  fromServerTrack
} from './mappers.js'

const EPOCH = '1970-01-01T00:00:00.000Z'
// Foreground poll cadence (battery-friendly). Fast while there is unsynced data
// to keep retrying the upload; slow when everything is synced (just catches
// other devices' edits). Immediate pushes + focus/visibility/online triggers
// still do most of the work.
const FAST_POLL_MS = 20_000 // 20s while data is pending
const SLOW_POLL_MS = 180_000 // 3 min when fully synced

let state = {
  enabled: supabaseEnabled,
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  syncing: false,
  pending: 0, // total items waiting (tasks + admin changes)
  pendingTasks: 0, // finished tasks waiting to upload (the headline number)
  lastError: null,
  lastSyncAt: null
}

const subs = new Set()
function setState(patch) {
  state = { ...state, ...patch }
  subs.forEach((fn) => {
    try {
      fn(state)
    } catch {
      /* ignore */
    }
  })
}
export function getSyncState() {
  return state
}
export function subscribeSync(fn) {
  subs.add(fn)
  fn(state)
  return () => subs.delete(fn)
}

let running = false
let queued = false
let started = false

export function startSync() {
  if (started) return
  started = true
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      setState({ online: true })
      requestSync()
    })
    window.addEventListener('offline', () => setState({ online: false }))
    // Catch up the moment the app is brought back to the foreground / focused
    // (timers are frozen while the screen is off or the app is backgrounded).
    window.addEventListener('focus', () => requestSync())
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        setState({ online: typeof navigator !== 'undefined' ? navigator.onLine : true })
        requestSync()
      }
    })
  }
  onChange(() => {
    refreshPending()
    requestSync()
  })
  // Adaptive foreground poll (skipped while hidden / frozen when screen is off).
  scheduleNextPoll()
  refreshPending()
  requestSync()
}

// Self-rescheduling poll: 20s while data is pending, 3 min when synced.
let pollTimer = null
function scheduleNextPoll() {
  if (pollTimer) clearTimeout(pollTimer)
  const delay = state.pending > 0 ? FAST_POLL_MS : SLOW_POLL_MS
  pollTimer = setTimeout(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') requestSync()
    scheduleNextPoll()
  }, delay)
}

// After a failed run, retry sooner than the next poll.
let retryTimer = null
function scheduleRetry() {
  if (retryTimer) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    requestSync()
  }, 15_000)
}

export function requestSync() {
  if (!supabaseEnabled) return
  if (typeof navigator !== 'undefined' && !navigator.onLine) return
  if (running) {
    queued = true
    return
  }
  run()
}

async function run() {
  running = true
  setState({ syncing: true, lastError: null })
  try {
    // Push local changes first so our edits win, then pull remote changes.
    // Order matters: presets + tasks before photos (photos FK -> tasks).
    await pushPresets()
    await pushTasks()
    await pushPhotos()
    await processTombstones()
    await pullPresets()
    await pullTasksAndPhotos()
    await reconcileTracks()
    const at = new Date().toISOString()
    await setMeta('lastSyncAt', at)
    setState({ lastSyncAt: at })
  } catch (e) {
    setState({ lastError: e?.message || String(e) })
    scheduleRetry() // try again in ~15s instead of waiting for the next minute
  } finally {
    await refreshPending()
    running = false
    setState({ syncing: false })
    scheduleNextPoll() // speed up / slow down based on what's still pending
    if (queued) {
      queued = false
      requestSync()
    }
  }
}

async function refreshPending() {
  try {
    // Count whole tasks waiting to upload (open or finished) — not photos — so
    // the badge reads "N tasks to sync", one per job.
    const [pendingTasks, ph, c, m, o, r, a, cl, lk, tr, tomb] = await Promise.all([
      db.tasks.where('syncStatus').equals(SyncStatus.PENDING).count(),
      // Photos with local bytes still to upload. Counted (not as "tasks") so a
      // stuck photo can't leave the chip claiming everything is synced.
      db.photos.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.companies.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.machines.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.operators.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.pieceRates.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.areas.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.claims.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.monthLocks.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.tracks.where('syncStatus').equals(SyncStatus.PENDING).count(),
      db.tombstones.count()
    ])
    const other = ph + c + m + o + r + a + cl + lk + tr + tomb // photos / settings / deletions / tracks
    setState({ pending: pendingTasks + other, pendingTasks })
  } catch {
    /* ignore */
  }
}

// ---- push ----------------------------------------------------------------

// A weak site connection can leave a request hanging for minutes. Give up and
// let the next cycle retry rather than stalling the whole run behind it.
const UPLOAD_TIMEOUT_MS = 60_000
const withTimeout = (promise, ms) =>
  Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('Upload timed out')), ms))])

async function pushPhotos() {
  const pending = await db.photos.where('syncStatus').equals(SyncStatus.PENDING).toArray()
  let failed = 0
  for (const p of pending) {
    if (!p.blob) {
      // Pulled-from-server placeholder with no local bytes — nothing to upload.
      if (p.storagePath) await markSynced(db.photos, p.id, p.updatedAt)
      continue
    }
    // Each photo is independent: one that won't upload (bad signal, oversized,
    // server hiccup) must not hold back the others — or the rest of the run,
    // which is where deletions and incoming records happen. It stays pending
    // with its bytes intact and is retried on the next cycle.
    try {
      const path = p.storagePath || `${p.taskId}/${p.id}.jpg`
      const up = await withTimeout(
        supabase.storage.from(PHOTO_BUCKET).upload(path, p.blob, { upsert: true, contentType: p.blob.type || 'image/jpeg' }),
        UPLOAD_TIMEOUT_MS
      )
      if (up.error) throw up.error
      const { error } = await supabase.from(tbl('photos')).upsert(toServerPhoto(p, path))
      if (error) throw error
      // Only finalise if the row hasn't changed underneath us.
      const cur = await db.photos.get(p.id)
      if (cur && cur.updatedAt === p.updatedAt) {
        await db.photos.update(p.id, { storagePath: path, syncStatus: SyncStatus.SYNCED })
      }
    } catch {
      failed++
    }
  }
  if (failed) scheduleRetry() // come back sooner to finish the stragglers
}

async function pushTasks() {
  // Push every pending task — including open ones — so a started job is backed
  // up to the cloud right away (survives a lost/broken phone).
  const pending = await db.tasks.where('syncStatus').equals(SyncStatus.PENDING).toArray()
  if (!pending.length) return
  const { error } = await supabase.from(tbl('tasks')).upsert(pending.map(toServerTask))
  if (error) throw error
  for (const t of pending) await markSynced(db.tasks, t.id, t.updatedAt, { serverId: t.id })
}

async function pushPresets() {
  await pushTable(db.companies, 'companies', toServerCompany)
  await pushTable(db.machines, 'machines', toServerMachine)
  await pushTable(db.operators, 'operators', toServerOperator)
  await pushTable(db.pieceRates, 'piece_rates', toServerPieceRate)
  await pushTable(db.areas, 'areas', toServerArea)
  await pushTable(db.claims, 'claims', toServerClaim)
  await pushTable(db.monthLocks, 'month_locks', toServerMonthLock)
  // GPS map recordings (can be large — jsonb points — but same generic path).
  await pushTable(db.tracks, 'tracks', toServerTrack)
}

async function pushTable(table, serverTable, mapper) {
  const pending = await table.where('syncStatus').equals(SyncStatus.PENDING).toArray()
  if (!pending.length) return
  const { error } = await supabase.from(tbl(serverTable)).upsert(pending.map(mapper))
  if (error) throw error
  for (const row of pending) await markSynced(table, row.id, row.updatedAt)
}

async function markSynced(table, id, expectedUpdatedAt, extra = {}) {
  const cur = await table.get(id)
  if (cur && cur.updatedAt === expectedUpdatedAt) {
    await table.update(id, { syncStatus: SyncStatus.SYNCED, ...extra })
  }
}

async function processTombstones() {
  const tombs = await db.tombstones.toArray()
  let failed = 0
  for (const t of tombs) {
    const now = new Date().toISOString()
    // Each tombstone is independent — a single stuck one must not block the rest
    // of the queue (otherwise later deletes, incl. their Storage removals, never
    // run). Failed ones stay in the table and retry on the next sync.
    try {
      if (t.table === 'photos') {
        // Remove the storage file (frees space), then soft-delete the row so other
        // devices drop it on their next pull.
        if (t.storagePath) {
          const { error } = await supabase.storage.from(PHOTO_BUCKET).remove([t.storagePath])
          if (error && !/not.?found/i.test(error.message || '')) throw error
        }
        if (t.serverId) {
          const { error } = await supabase.from(tbl('photos')).update({ deleted: true, updated_at: now }).eq('id', t.serverId)
          if (error) throw error
        }
      } else if (t.table === 'tracks' && t.serverId) {
        // Track deletions are permanent: removing either one recording or its
        // parent task must also remove the GPS geometry from Supabase. Unlike
        // the other synced entities, tracks intentionally do not retain a
        // server-side soft-delete marker.
        const { error } = await supabase.from(tbl('tracks')).delete().eq('id', t.serverId)
        if (error) throw error
      } else if (t.table === 'tasks' && t.serverId) {
        // A task may have tracks uploaded by another device that are not in
        // this device's IndexedDB. Delete by task_id as well as processing any
        // per-track tombstones created locally, so no server track is orphaned.
        const tracksResult = await supabase.from(tbl('tracks')).delete().eq('task_id', t.serverId)
        if (tracksResult.error) throw tracksResult.error
        const taskResult = await supabase
          .from(tbl('tasks'))
          .update({ deleted: true, updated_at: now })
          .eq('id', t.serverId)
        if (taskResult.error) throw taskResult.error
      } else if (t.serverId) {
        // Soft-delete (mark deleted + bump updated_at) rather than a hard delete, so
        // the removal reaches other devices through the normal pull.
        const { error } = await supabase.from(tbl(t.table)).update({ deleted: true, updated_at: now }).eq('id', t.serverId)
        if (error) throw error
      }
      await db.tombstones.delete(t.id)
    } catch {
      failed++ // keep the tombstone for a later retry, move on to the next
    }
  }
  if (failed) scheduleRetry() // come back sooner to finish the stragglers
}

// Older app builds soft-deleted tracks. Pull runs first so this device applies
// those deletion markers locally; only then remove the legacy rows (and their
// GPS geometry) permanently from Supabase. New builds hard-delete tracks in
// processTombstones(), so this is normally a no-op.
/**
 * Tracks are deleted from Supabase outright (no soft-delete marker), which the
 * cursor-based pull can't see — a row that no longer exists simply never comes
 * back in a `updated_at > cursor` query. So after pulling we compare local
 * tracks against the server's id list and drop any that are gone, which is how
 * an admin's deletion reaches the operator's device.
 *
 * Cheap: ids only, and this app has a handful of tracks per operator per month.
 * Rows still waiting to upload are kept — they don't exist on the server yet.
 */
let lastReconcileAt = 0
const RECONCILE_EVERY_MS = 5 * 60_000 // deletions are rare; no need every run

async function reconcileTracks() {
  if (Date.now() - lastReconcileAt < RECONCILE_EVERY_MS) return
  const local = (await db.tracks.toArray()).filter((t) => t.syncStatus !== SyncStatus.PENDING)
  lastReconcileAt = Date.now()
  if (!local.length) return
  // Ask about the ids THIS device holds, in batches — not "list every track",
  // which grew with the whole history and, past its row cap, would have started
  // reporting live tracks as missing and deleting them locally.
  const alive = new Set()
  for (let i = 0; i < local.length; i += 100) {
    const ids = local.slice(i, i + 100).map((t) => t.id)
    const { data, error } = await supabase.from(tbl('tracks')).select('id').in('id', ids)
    if (error) throw error
    for (const r of data || []) alive.add(r.id)
  }
  for (const t of local) if (!alive.has(t.id)) await db.tracks.delete(t.id)
}

// ---- pull ----------------------------------------------------------------

const PRESET_TABLES = [
  ['companies', () => db.companies, fromServerCompany],
  ['machines', () => db.machines, fromServerMachine],
  ['operators', () => db.operators, fromServerOperator],
  ['piece_rates', () => db.pieceRates, fromServerPieceRate],
  ['areas', () => db.areas, fromServerArea],
  ['claims', () => db.claims, fromServerClaim],
  ['month_locks', () => db.monthLocks, fromServerMonthLock],
  ['tracks', () => db.tracks, fromServerTrack]
]

/**
 * Fetch every preset table at once, then apply them one after another.
 *
 * Run in sequence these were eight round trips of pure latency — noticeable on
 * a weak site connection even when nothing had changed. The requests are
 * independent, so they overlap; the local writes stay sequential so IndexedDB
 * work doesn't interleave. Nothing is skipped, so data is exactly as fresh.
 */
async function pullPresets() {
  const fetched = await Promise.all(PRESET_TABLES.map(([name]) => fetchTable(name)))
  for (let i = 0; i < PRESET_TABLES.length; i++) {
    const [name, table, mapper] = PRESET_TABLES[i]
    await applyTable(name, table(), mapper, fetched[i])
  }
}

/** One table's changed rows since our cursor (network only — no local writes). */
async function fetchTable(serverTable) {
  const cursor = (await getMeta(`cursor.${serverTable}`)) || EPOCH
  const { data, error } = await supabase
    .from(tbl(serverTable))
    .select('*')
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(1000)
  if (error) throw error
  return { cursor, data }
}

async function pullTable(serverTable, dexieTable, mapper) {
  await applyTable(serverTable, dexieTable, mapper, await fetchTable(serverTable))
}

async function applyTable(serverTable, dexieTable, mapper, { cursor, data }) {
  const cursorKey = `cursor.${serverTable}`
  let maxCursor = cursor
  for (const row of data || []) {
    const local = mapper(row)
    if (row.updated_at > maxCursor) maxCursor = row.updated_at
    const existing = await dexieTable.get(local.id)
    // Don't clobber a local edit that hasn't synced yet and is newer.
    if (existing && existing.syncStatus === SyncStatus.PENDING && existing.updatedAt > local.updatedAt) {
      continue
    }
    if (row.deleted) await dexieTable.delete(local.id) // remote delete → drop locally
    else await dexieTable.put(local)
  }
  if (maxCursor !== cursor) await setMeta(cursorKey, maxCursor)
}

async function pullTasksAndPhotos() {
  // Both requests go out together, then are applied in order (tasks first —
  // photos reference them).
  const [tasksRes, photosRes] = await Promise.all([fetchTable('tasks'), fetchTable('photos')])
  // Tasks
  {
    const { cursor, data } = tasksRes
    let maxCursor = cursor
    for (const row of data || []) {
      if (row.updated_at > maxCursor) maxCursor = row.updated_at
      const local = fromServerTask(row)
      const existing = await db.tasks.get(local.id)
      if (existing && existing.syncStatus === SyncStatus.PENDING && existing.updatedAt > local.updatedAt) {
        continue
      }
      if (row.deleted) await db.tasks.delete(local.id) // remote delete → drop locally
      else await db.tasks.put(local)
    }
    if (maxCursor !== cursor) await setMeta('cursor.tasks', maxCursor)
  }
  // Photos (metadata only; bytes stay in Storage and load on demand)
  {
    const { cursor, data } = photosRes
    let maxCursor = cursor
    for (const row of data || []) {
      if (row.updated_at > maxCursor) maxCursor = row.updated_at
      const existing = await db.photos.get(row.id)
      if (existing && existing.syncStatus === SyncStatus.PENDING) continue
      if (row.deleted) await db.photos.delete(row.id) // remote delete → drop locally
      else await db.photos.put(fromServerPhoto(row, existing?.blob ?? null))
    }
    if (maxCursor !== cursor) await setMeta('cursor.photos', maxCursor)
  }
}
