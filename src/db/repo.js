// Central data access layer. Every page goes through these functions so that
// derived fields (duration, amount, day/month keys, sync flags) stay consistent
// and every write announces a change for the sync engine to pick up.

import { db } from './database.js'
import {
  TaskStatus,
  SyncStatus,
  PhotoKind,
  CreatedBy,
  GpsSource,
  emptyGeo,
  HOURLY_RATE_NAME,
  HOURLY_RATE_UNIT
} from './models.js'
import { uuid } from '../lib/uuid.js'
import { dayKeyOf, monthKeyOf, minRetainedMonthKey } from '../lib/format.js'
import { isDistanceUnit } from '../lib/dashboard.js'
import { minutesBetween } from '../lib/duration.js'
import { hashSecret } from '../lib/crypto.js'
import { emitChange } from '../sync/bus.js'

const nowISO = () => new Date().toISOString()
const numOrNull = (v) => {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

/**
 * @param {{blob: Blob, capturedAt: string|null, gps: object}|null} captured
 */
function buildPhoto(id, taskId, kind, captured) {
  return {
    id,
    taskId,
    kind,
    blob: captured?.blob ?? null,
    storagePath: null,
    capturedAt: captured?.capturedAt ?? null,
    gps: captured?.gps ?? emptyGeo(),
    syncStatus: SyncStatus.PENDING,
    updatedAt: nowISO()
  }
}

export function getPhoto(id) {
  return id ? db.photos.get(id) : Promise.resolve(undefined)
}

export function getPhotosForTask(taskId) {
  return db.photos.where('taskId').equals(taskId).toArray()
}

// ---------------------------------------------------------------------------
// Tasks — operator flow
// ---------------------------------------------------------------------------

/**
 * Operator starts a task: at least 1 start-mileage photo + 1 work photo.
 * The task then "hangs" as IN_PROGRESS until completed.
 * @returns {Promise<string>} new task id
 */
export async function startTask({ session, startTime, notes, startPhoto, workPhoto, startGps }) {
  const now = nowISO()
  const taskId = uuid()
  const startPhotoId = startPhoto ? uuid() : null
  const workPhotoId = workPhoto ? uuid() : null
  // Operator can edit the start time; otherwise use the meter photo's timestamp
  // (photo 1) — the optional photo 2 doesn't drive start time.
  const startTimeFinal = startTime || startPhoto?.capturedAt || now
  await assertMonthUnlocked(monthKeyOf(startTimeFinal))

  const task = {
    id: taskId,
    operatorId: session.operatorId,
    operatorName: session.operatorName,
    // Machine + company are chosen when the task is finished.
    companyId: null,
    companyName: null,
    machineId: null,
    machineName: null,
    status: TaskStatus.IN_PROGRESS,
    createdBy: CreatedBy.OPERATOR,

    startMileage: null,
    startTime: startTimeFinal,
    startGps: startGps || startPhoto?.gps || emptyGeo(),
    startPhotoId,
    workPhotoId,

    endMileage: null,
    endTime: null,
    endGps: emptyGeo(),
    endWorkPhotoId: null,
    endPhotoId: null,

    durationMinutes: null,

    pieceRateId: null,
    pieceRateName: null,
    unit: null,
    unitPrice: null,
    quantity: null,
    amount: null,

    areaId: null,
    areaName: null,

    notes: notes || '',
    dayKey: dayKeyOf(startTimeFinal),
    monthKey: monthKeyOf(startTimeFinal),

    syncStatus: SyncStatus.PENDING,
    serverId: null,
    createdAt: now,
    updatedAt: now
  }

  await db.transaction('rw', db.tasks, db.photos, async () => {
    await db.tasks.add(task)
    if (startPhoto) await db.photos.add(buildPhoto(startPhotoId, taskId, PhotoKind.START_MILEAGE, startPhoto))
    if (workPhoto) await db.photos.add(buildPhoto(workPhotoId, taskId, PhotoKind.WORK, workPhoto))
  })
  emitChange()
  return taskId
}

/**
 * Operator completes a hanging task: end-mileage photo + piece rate + quantity
 * + area. Duration is auto-derived from start photo time -> end photo time.
 */
export async function completeTask(taskId, { endTime, endWorkPhoto, endPhoto, machine, company, pieceRate, quantity, quantityExpr, area, notes, endGps }) {
  const task = await db.tasks.get(taskId)
  if (!task) throw new Error('Task not found')
  await assertMonthUnlocked(task.monthKey)

  const now = nowISO()
  const endWorkPhotoId = task.endWorkPhotoId || (endWorkPhoto ? uuid() : null)
  const endPhotoId = task.endPhotoId || (endPhoto ? uuid() : null)
  // Operator can edit the end time; otherwise use the ending meter photo's
  // timestamp (the true end-of-work moment), not the proof-of-work photo.
  const endTimeFinal = endTime || endPhoto?.capturedAt || task.endTime || now
  const qty = numOrNull(quantity)
  const unitPrice = pieceRate ? numOrNull(pieceRate.price) : null

  const patch = {
    status: TaskStatus.COMPLETED,
    machineId: machine?.id ?? task.machineId ?? null,
    machineName: machine?.name ?? task.machineName ?? null,
    companyId: company?.id ?? machine?.companyId ?? task.companyId ?? null,
    companyName: company?.name ?? task.companyName ?? null,
    endTime: endTimeFinal,
    endGps: endGps || endPhoto?.gps || endWorkPhoto?.gps || task.endGps || emptyGeo(),
    endWorkPhotoId,
    endPhotoId,
    durationMinutes: minutesBetween(task.startTime, endTimeFinal),

    pieceRateId: realRateId(pieceRate?.id),
    pieceRateName: pieceRate?.name ?? null,
    unit: pieceRate?.unit ?? null,
    unitPrice,
    quantity: qty,
    quantityExpr: quantityExpr ?? null,
    amount: qty != null && unitPrice != null ? round2(qty * unitPrice) : null,

    areaId: area?.id ?? null,
    areaName: area?.name ?? null,

    notes: notes ?? task.notes ?? '',
    syncStatus: SyncStatus.PENDING,
    updatedAt: now
  }

  await db.transaction('rw', db.tasks, db.photos, db.tracks, db.tombstones, async () => {
    await db.tasks.update(taskId, patch)
    if (endWorkPhoto && endWorkPhotoId) {
      const existing = await db.photos.get(endWorkPhotoId)
      const row = buildPhoto(endWorkPhotoId, taskId, PhotoKind.END_WORK, endWorkPhoto)
      if (existing) await db.photos.put({ ...existing, ...row })
      else await db.photos.add(row)
    }
    if (endPhoto && endPhotoId) {
      const existing = await db.photos.get(endPhotoId)
      const row = buildPhoto(endPhotoId, taskId, PhotoKind.END_MILEAGE, endPhoto)
      if (existing) await db.photos.put({ ...existing, ...row })
      else await db.photos.add(row)
    }
    // Finished as work that isn't measured in distance? Any paths recorded
    // earlier belong to a job that was abandoned — drop them (tombstoned, so
    // they're removed from Supabase too) instead of leaving them on the maps.
    if (patch.unit && !isDistanceUnit(patch.unit)) {
      const strays = await db.tracks.where('taskId').equals(taskId).toArray()
      for (const tr of strays) {
        await db.tombstones.put({ id: uuid(), table: 'tracks', serverId: tr.id, createdAt: now })
        await db.tracks.delete(tr.id)
      }
    }
  })
  emitChange()
}

/**
 * Operator saves a half-finished task WITHOUT completing it. Everything is
 * optional; the task stays IN_PROGRESS so it keeps showing under Open tasks and
 * can be resumed later. Mirrors completeTask, minus the required fields and the
 * COMPLETED status.
 */
export async function saveTaskProgress(
  taskId,
  { endTime, endWorkPhoto, endPhoto, removeEndWorkPhoto = false, removeEndPhoto = false, machine, company, pieceRate, quantity, quantityExpr, area, notes, endGps }
) {
  const task = await db.tasks.get(taskId)
  if (!task) throw new Error('Task not found')
  await assertMonthUnlocked(task.monthKey)

  const now = nowISO()
  // A cleared photo drops its id (and its row + Storage file below); otherwise
  // keep the existing one, or mint a new id for a freshly captured photo.
  const endWorkPhotoId = removeEndWorkPhoto ? null : task.endWorkPhotoId || (endWorkPhoto ? uuid() : null)
  const endPhotoId = removeEndPhoto ? null : task.endPhotoId || (endPhoto ? uuid() : null)
  // A draft may not have an end time yet — keep it null until known. When taken
  // from a photo, use the ending meter photo (not proof-of-work).
  const endTimeFinal = endTime || endPhoto?.capturedAt || task.endTime || null
  const qty = numOrNull(quantity)
  const unitPrice = pieceRate ? numOrNull(pieceRate.price) : null

  const patch = {
    status: TaskStatus.IN_PROGRESS, // still hanging — this is a draft save
    machineId: machine?.id ?? task.machineId ?? null,
    machineName: machine?.name ?? task.machineName ?? null,
    companyId: company?.id ?? machine?.companyId ?? task.companyId ?? null,
    companyName: company?.name ?? task.companyName ?? null,
    endTime: endTimeFinal,
    endGps: endGps || endPhoto?.gps || endWorkPhoto?.gps || task.endGps || emptyGeo(),
    endWorkPhotoId,
    endPhotoId,
    durationMinutes: endTimeFinal ? minutesBetween(task.startTime, endTimeFinal) : null,

    pieceRateId: realRateId(pieceRate?.id),
    pieceRateName: pieceRate?.name ?? null,
    unit: pieceRate?.unit ?? null,
    unitPrice,
    quantity: qty,
    quantityExpr: quantityExpr ?? null,
    amount: qty != null && unitPrice != null ? round2(qty * unitPrice) : null,

    areaId: area?.id ?? null,
    areaName: area?.name ?? null,

    notes: notes ?? task.notes ?? '',
    syncStatus: SyncStatus.PENDING,
    updatedAt: now
  }

  await db.transaction('rw', db.tasks, db.photos, db.tombstones, async () => {
    await db.tasks.update(taskId, patch)
    // Photos the operator cleared — drop the row and remove the Storage file.
    if (removeEndWorkPhoto && task.endWorkPhotoId) await tombstonePhoto(taskId, task.endWorkPhotoId, now)
    if (removeEndPhoto && task.endPhotoId) await tombstonePhoto(taskId, task.endPhotoId, now)
    if (endWorkPhoto && endWorkPhotoId) {
      const existing = await db.photos.get(endWorkPhotoId)
      const row = buildPhoto(endWorkPhotoId, taskId, PhotoKind.END_WORK, endWorkPhoto)
      if (existing) await db.photos.put({ ...existing, ...row })
      else await db.photos.add(row)
    }
    if (endPhoto && endPhotoId) {
      const existing = await db.photos.get(endPhotoId)
      const row = buildPhoto(endPhotoId, taskId, PhotoKind.END_MILEAGE, endPhoto)
      if (existing) await db.photos.put({ ...existing, ...row })
      else await db.photos.add(row)
    }
  })
  emitChange()
}

// Tombstone one photo (removes its Storage file + row on the next sync) and drop
// the local row now. Must run inside a rw transaction over photos + tombstones.
async function tombstonePhoto(taskId, photoId, now) {
  const p = await db.photos.get(photoId)
  await db.tombstones.put({
    id: uuid(),
    table: 'photos',
    serverId: photoId,
    storagePath: p?.storagePath || `${taskId}/${photoId}.jpg`,
    createdAt: now
  })
  await db.photos.delete(photoId)
}

// ---------------------------------------------------------------------------
// Tasks — admin
// ---------------------------------------------------------------------------

/** Admin adds a (completed) task manually. Photos (start/work/end) are optional. */
export async function addManualTask(input) {
  const now = nowISO()
  const startTime = input.startTime || now
  await assertMonthUnlocked(monthKeyOf(startTime))
  const endTime = input.endTime || null
  const qty = numOrNull(input.quantity)
  const unitPrice = input.pieceRate ? numOrNull(input.pieceRate.price) : null

  const taskId = uuid()
  const startPhotoId = input.startPhoto ? uuid() : null
  const workPhotoId = input.workPhoto ? uuid() : null
  const endWorkPhotoId = input.endWorkPhoto ? uuid() : null
  const endPhotoId = input.endPhoto ? uuid() : null

  const task = {
    id: taskId,
    operatorId: input.operator.id,
    operatorName: input.operator.name,
    machineId: input.machine?.id ?? null,
    machineName: input.machine?.name ?? null,
    companyId: input.company?.id ?? input.machine?.companyId ?? null,
    companyName: input.company?.name ?? null,
    status: TaskStatus.COMPLETED,
    createdBy: input.createdBy ?? CreatedBy.ADMIN,

    startMileage: numOrNull(input.startMileage),
    startTime,
    startGps: input.startGps || input.startPhoto?.gps || { ...emptyGeo(), source: GpsSource.MANUAL },
    startPhotoId,
    workPhotoId,

    endMileage: numOrNull(input.endMileage),
    endTime,
    endGps: input.endGps || input.endPhoto?.gps || { ...emptyGeo(), source: GpsSource.MANUAL },
    endWorkPhotoId,
    endPhotoId,

    // Explicit override (hour-meter or direct hours), else derived from times.
    durationMinutes: input.durationMinutes != null ? input.durationMinutes : minutesBetween(startTime, endTime),

    pieceRateId: realRateId(input.pieceRate?.id),
    pieceRateName: input.pieceRate?.name ?? null,
    unit: input.pieceRate?.unit ?? null,
    unitPrice,
    quantity: qty,
    quantityExpr: input.quantityExpr ?? null,
    amount: qty != null && unitPrice != null ? round2(qty * unitPrice) : null,

    areaId: input.area?.id ?? null,
    areaName: input.area?.name ?? null,

    notes: input.notes || '',
    dayKey: dayKeyOf(startTime),
    monthKey: monthKeyOf(startTime),

    syncStatus: SyncStatus.PENDING,
    serverId: null,
    createdAt: now,
    updatedAt: now
  }
  await db.transaction('rw', db.tasks, db.photos, async () => {
    await db.tasks.add(task)
    if (input.startPhoto) await db.photos.add(buildPhoto(startPhotoId, taskId, PhotoKind.START_MILEAGE, input.startPhoto))
    if (input.workPhoto) await db.photos.add(buildPhoto(workPhotoId, taskId, PhotoKind.WORK, input.workPhoto))
    if (input.endWorkPhoto) await db.photos.add(buildPhoto(endWorkPhotoId, taskId, PhotoKind.END_WORK, input.endWorkPhoto))
    if (input.endPhoto) await db.photos.add(buildPhoto(endPhotoId, taskId, PhotoKind.END_MILEAGE, input.endPhoto))
  })
  emitChange()
  return taskId
}

/**
 * Admin edits any fields of a task (times, GPS, mileage, quantity, rate, area).
 * Pass a partial patch; derived fields are recomputed from the merged result.
 */
export async function updateTask(taskId, patch, photos = {}) {
  const task = await db.tasks.get(taskId)
  if (!task) throw new Error('Task not found')

  const merged = { ...task, ...patch }
  merged.pieceRateId = realRateId(merged.pieceRateId) // never store the Kerja jam sentinel
  // Honour an explicit duration (hour-meter / direct hours, which have no end
  // time); otherwise derive it from the start/end timestamps.
  merged.durationMinutes =
    patch.durationMinutes != null ? patch.durationMinutes : minutesBetween(merged.startTime, merged.endTime)
  const baseTime = merged.startTime || merged.createdAt
  merged.dayKey = dayKeyOf(baseTime)
  merged.monthKey = monthKeyOf(baseTime)
  // Block edits if the record's current month OR the month it would move to is locked.
  await assertMonthUnlocked(task.monthKey)
  await assertMonthUnlocked(merged.monthKey)
  merged.amount =
    merged.quantity != null && merged.unitPrice != null
      ? round2(Number(merged.quantity) * Number(merged.unitPrice))
      : null
  merged.updatedAt = nowISO()
  merged.syncStatus = SyncStatus.PENDING

  // New / replacement photos (admin upload on edit). Reuse the existing slot id
  // so a replacement overwrites the same row; create one for an empty slot.
  const slots = [
    ['startPhoto', 'startPhotoId', PhotoKind.START_MILEAGE],
    ['workPhoto', 'workPhotoId', PhotoKind.WORK],
    ['endWorkPhoto', 'endWorkPhotoId', PhotoKind.END_WORK],
    ['endPhoto', 'endPhotoId', PhotoKind.END_MILEAGE]
  ]
  for (const [key, idKey] of slots) {
    if (photos[key]) merged[idKey] = merged[idKey] || uuid()
  }

  await db.transaction('rw', db.tasks, db.photos, async () => {
    await db.tasks.put(merged)
    for (const [key, idKey, kind] of slots) {
      const cap = photos[key]
      if (!cap) continue
      const pid = merged[idKey]
      const existing = await db.photos.get(pid)
      const row = buildPhoto(pid, taskId, kind, cap)
      if (existing) await db.photos.put({ ...existing, ...row })
      else await db.photos.add(row)
    }
  })
  emitChange()
  return merged
}

export async function deleteTask(taskId, { skipLockCheck = false } = {}) {
  const task = await db.tasks.get(taskId)
  if (!skipLockCheck) await assertMonthUnlocked(task?.monthKey)
  await db.transaction('rw', db.tasks, db.photos, db.tracks, db.tombstones, async () => {
    const now = nowISO()
    const photos = await db.photos.where('taskId').equals(taskId).toArray()
    if (task?.serverId) {
      await db.tombstones.put({ id: uuid(), table: 'tasks', serverId: task.serverId, createdAt: now })
    }
    // One tombstone per photo id tied to this task — each removes the Storage
    // file AND soft-deletes the DB row. Cover both the local photo rows and the
    // task's own photo slots, so the file is still removed even if this device
    // never pulled the photo rows. Path is deterministic: `<taskId>/<photoId>.jpg`.
    const paths = new Map() // photoId -> storagePath
    for (const p of photos) paths.set(p.id, p.storagePath || `${taskId}/${p.id}.jpg`)
    for (const pid of [task?.startPhotoId, task?.workPhotoId, task?.endWorkPhotoId, task?.endPhotoId]) {
      if (pid && !paths.has(pid)) paths.set(pid, `${taskId}/${pid}.jpg`)
    }
    for (const [pid, storagePath] of paths) {
      await db.tombstones.put({ id: uuid(), table: 'photos', serverId: pid, storagePath, createdAt: now })
    }
    await db.photos.where('taskId').equals(taskId).delete()
    // GPS/drawn paths belong to the task — otherwise they'd linger on the maps
    // after the record is gone.
    const tracks = await db.tracks.where('taskId').equals(taskId).toArray()
    for (const tr of tracks) {
      await db.tombstones.put({ id: uuid(), table: 'tracks', serverId: tr.id, createdAt: now })
      await db.tracks.delete(tr.id)
    }
    await db.tasks.delete(taskId)
  })
  emitChange()
}

// ---------------------------------------------------------------------------
// Task queries
// ---------------------------------------------------------------------------

export function getTask(id) {
  return db.tasks.get(id)
}

/** Hanging (IN_PROGRESS) tasks for the logged-in operator, newest first. */
export async function getOpenTasks(session) {
  if (!session?.operatorId) return []
  const rows = await db.tasks
    .where('[operatorId+status]')
    .equals([session.operatorId, TaskStatus.IN_PROGRESS])
    .toArray()
  return rows.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
}

/** All in-progress tasks across everyone (admin), newest first. */
export async function getAllOpenTasks() {
  const rows = await db.tasks.where('status').equals(TaskStatus.IN_PROGRESS).toArray()
  return rows.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
}

/**
 * Tasks for a month.
 *  - operatorId   -> one operator's records (their monthly claim)
 *  - operatorIds  -> selected operators (admin)
 *  - neither      -> everyone (admin "all")
 */
export async function getMonthTasks({ operatorId, operatorIds, monthKey }) {
  let rows
  if (operatorId) {
    rows = await db.tasks.where('[operatorId+monthKey]').equals([operatorId, monthKey]).toArray()
  } else {
    rows = await db.tasks.where('monthKey').equals(monthKey).toArray()
  }
  if (operatorIds && operatorIds.length) {
    const set = new Set(operatorIds)
    rows = rows.filter((t) => set.has(t.operatorId))
  }
  return rows
}

/**
 * The latest month ("YYYY-MM") that has at least one real claim — a completed
 * task with a non-zero amount for a still-existing company. Payroll defaults to
 * this so it doesn't jump to an empty RM0 month at the start of a new month; the
 * new month only becomes the default (and reachable) once it has a claim.
 * Returns null when there are no claims yet.
 */
export async function getLatestClaimMonth() {
  const companyIds = new Set((await db.companies.toArray()).map((c) => c.id))
  const completed = await db.tasks.filter((t) => t.status === TaskStatus.COMPLETED).toArray()
  let max = null
  for (const t of completed) {
    if ((Number(t.amount) || 0) === 0) continue // RM0 work isn't a claim
    if (t.companyId && !companyIds.has(t.companyId)) continue // deleted company
    if (!max || t.monthKey > max) max = t.monthKey
  }
  return max
}

/** All tasks whose work month falls in the given calendar year (for the dashboard). */
export function getYearTasks(year) {
  return db.tasks.where('monthKey').between(`${year}-01`, `${year}-12`, true, true).toArray()
}

// ---------------------------------------------------------------------------
// Presets: piece rates (per machine), areas, operators, companies, machines
// ---------------------------------------------------------------------------

/** Piece rates, optionally for one machine. */
export async function listPieceRates({ machineId, includeInactive = false } = {}) {
  let all = await db.pieceRates.orderBy('name').toArray()
  if (machineId) all = all.filter((r) => r.machineId === machineId)
  return includeInactive ? all : all.filter((r) => r.active)
}

export async function upsertPieceRate(input) {
  const now = nowISO()
  const row = {
    id: input.id || uuid(),
    machineId: input.machineId ?? null,
    name: (input.name || '').trim(),
    unit: (input.unit || '').trim(),
    price: numOrNull(input.price) ?? 0,
    active: input.active !== false,
    updatedAt: now,
    syncStatus: SyncStatus.PENDING
  }
  await db.pieceRates.put(row)
  emitChange()
  return row
}

export async function deletePieceRate(id) {
  await tombstoneAndDelete(db.pieceRates, 'piece_rates', id)
}

const isHourlyRate = (r) => (r.name || '').trim().toLowerCase() === HOURLY_RATE_NAME.toLowerCase()

// "Kerja jam" is a virtual, per-operator piece rate (priced from the operator's
// own hourly rate) that can be picked when recording a task — it is NOT stored
// as a machine rate.
export const KERJA_JAM_ID = 'kerja-jam'
export function kerjaJamRate(operator) {
  return { id: KERJA_JAM_ID, name: HOURLY_RATE_NAME, unit: HOURLY_RATE_UNIT, price: Number(operator?.hourlyRate) || 0, active: true }
}
// The "Kerja jam" rate isn't a real row — its sentinel id must never reach the
// task's piece_rate_id (a uuid column on the server). Store null but keep the
// name/unit/price snapshot.
const realRateId = (id) => (id && id !== KERJA_JAM_ID ? id : null)

/** Fix tasks saved before the sentinel-id guard so they can sync again. */
export async function repairKerjaJamTasks() {
  const bad = await db.tasks.filter((t) => t.pieceRateId === KERJA_JAM_ID).toArray()
  for (const t of bad) {
    await db.tasks.update(t.id, { pieceRateId: null, updatedAt: nowISO(), syncStatus: SyncStatus.PENDING })
  }
  if (bad.length) emitChange()
  return bad.length
}

/** One-time cleanup: drop any machine-level "Kerja jam" rate from an earlier build. */
export async function cleanupMachineHourlyRates() {
  const stale = (await db.pieceRates.toArray()).filter(isHourlyRate)
  for (const r of stale) await tombstoneAndDelete(db.pieceRates, 'piece_rates', r.id)
  return stale.length
}

/** Areas, optionally scoped to one company (areas belong to a company). */
export async function listAreas({ companyId, includeInactive = false } = {}) {
  let all = await db.areas.orderBy('name').toArray()
  if (companyId) all = all.filter((a) => a.companyId === companyId)
  return includeInactive ? all : all.filter((a) => a.active)
}

export async function upsertArea(input) {
  const existing = input.id ? await db.areas.get(input.id) : null
  const now = nowISO()
  const row = {
    id: input.id || uuid(),
    companyId: input.companyId ?? existing?.companyId ?? null,
    name: (input.name || '').trim(),
    active: input.active !== false,
    updatedAt: now,
    syncStatus: SyncStatus.PENDING
  }
  await db.areas.put(row)
  emitChange()
  return row
}

export async function deleteArea(id) {
  await tombstoneAndDelete(db.areas, 'areas', id)
}

// ---- Companies ----
export async function listCompanies({ includeInactive = false } = {}) {
  const all = await db.companies.orderBy('name').toArray()
  return includeInactive ? all : all.filter((c) => c.active)
}

export function getCompany(id) {
  return id ? db.companies.get(id) : Promise.resolve(undefined)
}

export async function upsertCompany(input) {
  const existing = input.id ? await db.companies.get(input.id) : null
  const now = nowISO()
  const row = {
    id: input.id || uuid(),
    name: (input.name || '').trim(),
    active: input.active !== false,
    // Default signers for the claim form (kept across edits).
    signers: input.signers ?? existing?.signers ?? null,
    // Uploaded KML/GPX site outline. Only replaced when explicitly passed, so
    // editing the company name elsewhere can't wipe it (`null` clears it).
    boundary: input.boundary !== undefined ? input.boundary : (existing?.boundary ?? null),
    updatedAt: now,
    syncStatus: SyncStatus.PENDING
  }
  await db.companies.put(row)
  emitChange()
  return row
}

/** Save just the claim-form signer defaults for a company. */
export async function setCompanySigners(id, signers) {
  await db.companies.update(id, { signers, updatedAt: nowISO(), syncStatus: SyncStatus.PENDING })
  emitChange()
}

/**
 * Delete a company AND everything under it — machines, their piece rates,
 * operators (and their saved claim extras), areas, and tasks (with photos).
 * Every delete is tombstoned, so it also propagates to Supabase.
 */
export async function deleteCompany(id) {
  if (!id) return
  const [machines, operators, areas, tasks] = await Promise.all([
    db.machines.where('companyId').equals(id).toArray(),
    db.operators.filter((o) => o.companyId === id).toArray(),
    db.areas.filter((a) => a.companyId === id).toArray(),
    db.tasks.where('companyId').equals(id).toArray()
  ])
  // Tasks first (also removes their photos + storage files).
  for (const t of tasks) await deleteTask(t.id, { skipLockCheck: true })
  // Machines + the piece rates under each.
  for (const m of machines) {
    const rates = await db.pieceRates.where('machineId').equals(m.id).toArray()
    for (const r of rates) await tombstoneAndDelete(db.pieceRates, 'piece_rates', r.id)
    await tombstoneAndDelete(db.machines, 'machines', m.id)
  }
  // Operators + their saved claim extras.
  for (const o of operators) {
    const claims = await db.claims.where('operatorId').equals(o.id).toArray()
    for (const c of claims) await tombstoneAndDelete(db.claims, 'claims', c.id)
    await tombstoneAndDelete(db.operators, 'operators', o.id)
  }
  // Areas, then the company itself.
  for (const a of areas) await tombstoneAndDelete(db.areas, 'areas', a.id)
  await tombstoneAndDelete(db.companies, 'companies', id)
  emitChange()
}

// ---------------------------------------------------------------------------
// GPS tracks (map distance recordings)
// ---------------------------------------------------------------------------

/**
 * Save a finished map recording. Points come from TrackRecorder.stop().
 * The distance snapshot is what fills the task's quantity for meter-unit work.
 */
export async function addTrack({
  session,
  taskId,
  pieceRate,
  points,
  distanceMeters,
  startedAt,
  endedAt,
  manual = false,
  drawnBy = null
}) {
  const started = startedAt || nowISO()
  await assertMonthUnlocked(monthKeyOf(started))
  const track = {
    id: uuid(),
    operatorId: session.operatorId,
    operatorName: session.operatorName ?? null,
    taskId: taskId ?? null,
    pieceRateId: pieceRate?.id ?? null,
    pieceRateName: pieceRate?.name ?? null,
    companyId: session.companyId ?? null,
    points: points || [],
    distanceMeters: Math.round((Number(distanceMeters) || 0) * 10) / 10,
    startedAt: started,
    endedAt: endedAt || nowISO(),
    manual: !!manual, // drawn by an admin rather than recorded by GPS
    drawnBy: manual ? drawnBy || null : null,
    dayKey: dayKeyOf(started),
    monthKey: monthKeyOf(started),
    syncStatus: SyncStatus.PENDING,
    updatedAt: nowISO()
  }
  await db.tracks.add(track)
  await syncTaskQuantityFromTracks(taskId)
  emitChange()
  return track
}

/**
 * Re-derive a task's quantity from its GPS/drawn paths and store it on the task
 * itself, so an admin adding or deleting a path immediately reaches the
 * operator's device (and payroll) through the normal task sync — not just the
 * screen that happened to make the change.
 */
export async function syncTaskQuantityFromTracks(taskId) {
  if (!taskId) return
  const task = await db.tasks.get(taskId)
  if (!task) return
  // Only distance work takes its quantity from the paths. If the job was
  // switched to hours/days, leave the typed quantity alone — metres must never
  // overwrite a quantity that is counted in another unit.
  if (task.unit && !isDistanceUnit(task.unit)) return
  const rows = (await db.tracks.where('taskId').equals(taskId).toArray()).sort((a, b) =>
    (a.startedAt || '').localeCompare(b.startedAt || '')
  )
  const each = rows.map((t) => Math.round((Number(t.distanceMeters) || 0) * 10) / 10)
  const total = each.length ? Math.round(each.reduce((s, n) => s + n, 0) * 10) / 10 : null
  const unitPrice = numOrNull(task.unitPrice)
  await db.tasks.update(taskId, {
    quantity: total,
    quantityExpr: each.length > 1 ? each.join('+') : null,
    amount: total != null && unitPrice != null ? round2(total * unitPrice) : null,
    syncStatus: SyncStatus.PENDING,
    updatedAt: nowISO()
  })
}

/**
 * Replace a drawn path's geometry (admin vertex editing). GPS recordings are
 * never reshaped — only hand-drawn paths can be edited.
 */
export async function updateTrackPoints(id, points, distanceMeters, { allowRecorded = false, editedBy = null } = {}) {
  const tr = await db.tracks.get(id)
  if (!tr) throw new Error('Path not found')
  // Drawn paths are freely editable; a GPS recording may only be reshaped by an
  // HQ admin, and the fact it was altered is stamped on the row.
  if (!tr.manual && !allowRecorded) throw new Error('Only drawn paths can be edited.')
  await assertMonthUnlocked(tr.monthKey)
  await db.tracks.update(id, {
    points: points || [],
    distanceMeters: Math.round((Number(distanceMeters) || 0) * 10) / 10,
    ...(tr.manual ? {} : { editedBy: editedBy || 'HQ admin' }),
    syncStatus: SyncStatus.PENDING,
    updatedAt: nowISO()
  })
  await syncTaskQuantityFromTracks(tr.taskId)
  emitChange()
}

/** An operator's tracks for one month, oldest first (map overlay + export). */
export async function listTracks({ operatorId, monthKey }) {
  const rows = await db.tracks.where('[operatorId+monthKey]').equals([operatorId, monthKey]).toArray()
  return rows.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
}

/** Total recorded meters for one task (fills its quantity when unit is meters). */
export async function taskTrackTotal(taskId) {
  if (!taskId) return 0
  const rows = await db.tracks.where('taskId').equals(taskId).toArray()
  return Math.round(rows.reduce((s, t) => s + (Number(t.distanceMeters) || 0), 0) * 10) / 10
}

/** All recordings for one task, oldest first — the audit breakdown of its quantity. */
export async function listTaskTracks(taskId) {
  if (!taskId) return []
  const rows = await db.tracks.where('taskId').equals(taskId).toArray()
  return rows.sort((a, b) => (a.startedAt || '').localeCompare(b.startedAt || ''))
}

export async function deleteTrack(id) {
  const tr = await db.tracks.get(id)
  if (!tr) return
  await assertMonthUnlocked(tr.monthKey)
  await db.transaction('rw', db.tracks, db.tombstones, async () => {
    await db.tombstones.put({ id: uuid(), table: 'tracks', serverId: tr.id, createdAt: nowISO() })
    await db.tracks.delete(id)
  })
  // Keep the task's quantity in step so the removal reaches every device.
  await syncTaskQuantityFromTracks(tr.taskId)
  emitChange()
}

// ---- Claim extras (per operator + month: Bahagian B incentives) ----------
const claimId = (operatorId, monthKey) => `${operatorId}__${monthKey}`

/** The saved claim extras for one operator + month, or null if none yet. */
export function getClaim(operatorId, monthKey) {
  if (!operatorId || !monthKey) return Promise.resolve(null)
  return db.claims.get(claimId(operatorId, monthKey)).then((r) => r ?? null)
}

/** All saved claim extras, optionally for one month (used by payroll totals). */
export async function listClaims({ monthKey } = {}) {
  const all = await db.claims.toArray()
  return monthKey ? all.filter((c) => c.monthKey === monthKey) : all
}

// ---- Month locks (freeze a month's records + payroll) --------------------
/** True if that work/payroll month is locked. */
export async function isMonthLocked(monthKey) {
  if (!monthKey) return false
  const row = await db.monthLocks.get(monthKey)
  return !!row?.locked
}

/** All month-lock rows (used to flag months in lists). */
export function listMonthLocks() {
  return db.monthLocks.toArray()
}

/** Lock or unlock a month. */
export async function setMonthLock(monthKey, locked) {
  if (!monthKey) return
  const now = nowISO()
  await db.monthLocks.put({
    id: monthKey,
    locked: !!locked,
    lockedAt: locked ? now : null,
    updatedAt: now,
    syncStatus: SyncStatus.PENDING
  })
  emitChange()
}

/** Throw if the given month is locked (guards every record-changing write). */
async function assertMonthUnlocked(monthKey) {
  if (await isMonthLocked(monthKey)) {
    throw new Error('This month is locked. Unlock it in Payroll before making changes.')
  }
}

// ---- Retention: auto-purge data older than the 3-year window -------------
/**
 * Deletes tasks (with their photos) and saved claim extras whose WORK / payroll
 * month is older than the retention window. Judged by the saved data month
 * (`monthKey`), not the edit date. Deletions tombstone so the server rows and
 * photo files are removed on the next sync, freeing Supabase space.
 */
export async function purgeOldData(now = new Date()) {
  const cutoff = minRetainedMonthKey(now) // oldest month we keep
  const oldTasks = await db.tasks.filter((t) => (t.monthKey || '') < cutoff).toArray()
  for (const t of oldTasks) await deleteTask(t.id, { skipLockCheck: true })
  const oldClaims = await db.claims.filter((c) => (c.monthKey || '') < cutoff).toArray()
  for (const c of oldClaims) await tombstoneAndDelete(db.claims, 'claims', c.id)
  // GPS tracks follow the same window (they're heavy: thousands of points each).
  const oldTracks = await db.tracks.filter((t) => (t.monthKey || '') < cutoff).toArray()
  for (const t of oldTracks) await tombstoneAndDelete(db.tracks, 'tracks', t.id)
  return { tasks: oldTasks.length, claims: oldClaims.length, tracks: oldTracks.length, cutoff }
}

/** Save the Bahagian B incentive rows for one operator + month. */
export async function saveClaimIncentives(operatorId, monthKey, incentives) {
  await assertMonthUnlocked(monthKey)
  const id = claimId(operatorId, monthKey)
  const existing = await db.claims.get(id)
  const row = {
    ...existing,
    id,
    operatorId,
    monthKey,
    incentives: (incentives || []).map((r) => ({
      desc: r.desc || '',
      unit: r.unit || '',
      rate: r.rate ?? '',
      qty: r.qty ?? ''
    })),
    updatedAt: nowISO(),
    syncStatus: SyncStatus.PENDING
  }
  await db.claims.put(row)
  emitChange()
  return row
}

// ---- Machines (belong to a company; login is by operator now, no PIN) ----
export async function listMachines({ companyId, includeInactive = false } = {}) {
  let all = await db.machines.orderBy('name').toArray()
  if (companyId) all = all.filter((m) => m.companyId === companyId)
  return includeInactive ? all : all.filter((m) => m.active)
}

export function getMachine(id) {
  return id ? db.machines.get(id) : Promise.resolve(undefined)
}

export async function upsertMachine(input) {
  const existing = input.id ? await db.machines.get(input.id) : null
  const now = nowISO()
  const row = {
    id: input.id || uuid(),
    companyId: input.companyId ?? existing?.companyId ?? null,
    name: (input.name || '').trim(),
    active: input.active !== false,
    updatedAt: now,
    syncStatus: SyncStatus.PENDING
  }
  await db.machines.put(row)
  emitChange()
  return row
}

export async function deleteMachine(id) {
  await tombstoneAndDelete(db.machines, 'machines', id)
}

// ---- Operators (the account: name + PIN + which machines they may use) ----
export async function listOperators({ includeInactive = false } = {}) {
  const all = await db.operators.orderBy('name').toArray()
  return includeInactive ? all : all.filter((o) => o.active)
}

export function getOperator(id) {
  return id ? db.operators.get(id) : Promise.resolve(undefined)
}

export async function upsertOperator(input) {
  const existing = input.id ? await db.operators.get(input.id) : null
  const now = nowISO()
  const name = (input.name || '').trim()
  // Usernames must be unique (case-insensitive) so login is unambiguous.
  const lower = name.toLowerCase()
  const clash = (await db.operators.toArray()).find(
    (o) => o.id !== (input.id || '') && (o.name || '').trim().toLowerCase() === lower
  )
  if (clash) throw new Error(`Username "${name}" is already taken.`)
  const row = {
    id: input.id || uuid(),
    name,
    companyId: input.companyId ?? existing?.companyId ?? null,
    // pin (plain, so admin can view it) + pinHash are set via setOperatorPin.
    pin: input.pin ?? existing?.pin ?? null,
    pinHash: input.pinHash ?? existing?.pinHash ?? null,
    active: input.active !== false,
    isSiteAdmin: input.isSiteAdmin ?? existing?.isSiteAdmin ?? false,
    // Pay defaults used to prefill the claim form.
    basicSalary: input.basicSalary !== undefined ? numOrNull(input.basicSalary) : existing?.basicSalary ?? null,
    phoneAllowance: input.phoneAllowance !== undefined ? numOrNull(input.phoneAllowance) : existing?.phoneAllowance ?? null,
    hourlyRate: input.hourlyRate !== undefined ? numOrNull(input.hourlyRate) : existing?.hourlyRate ?? null,
    machineIds: input.machineIds ?? existing?.machineIds ?? [],
    // Bumping this signs the operator out of every device on their next sync.
    forceLogoutAt: input.forceLogout ? now : existing?.forceLogoutAt ?? null,
    updatedAt: now,
    syncStatus: SyncStatus.PENDING
  }
  await db.operators.put(row)
  emitChange()
  return row
}

/** Set an operator's PIN (stores it plain for admin viewing + a hash for login). */
export async function setOperatorPin(id, pin) {
  const pinHash = await hashSecret(pin)
  await db.operators.update(id, { pin, pinHash, updatedAt: nowISO(), syncStatus: SyncStatus.PENDING })
  emitChange()
}

export async function deleteOperator(id) {
  await tombstoneAndDelete(db.operators, 'operators', id)
}

/** Active machines the operator may use — assigned to them AND in their company. */
export async function listOperatorMachines(operatorId) {
  const op = operatorId ? await db.operators.get(operatorId) : null
  const ids = new Set(op?.machineIds || [])
  if (!ids.size) return []
  const machines = await db.machines.orderBy('name').toArray()
  return machines.filter(
    (m) => m.active && ids.has(m.id) && (!op.companyId || m.companyId === op.companyId)
  )
}

async function tombstoneAndDelete(table, serverTable, id) {
  const row = await table.get(id)
  await db.transaction('rw', table, db.tombstones, async () => {
    if (row) {
      await db.tombstones.put({
        id: uuid(),
        table: serverTable,
        serverId: id,
        createdAt: nowISO()
      })
    }
    await table.delete(id)
  })
  emitChange()
}

// ---------------------------------------------------------------------------
// Sync status helpers
// ---------------------------------------------------------------------------

export async function countPending() {
  const [tasks, photos] = await Promise.all([
    db.tasks.where('syncStatus').equals(SyncStatus.PENDING).count(),
    db.photos.where('syncStatus').equals(SyncStatus.PENDING).count()
  ])
  return tasks + photos
}
