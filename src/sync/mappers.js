// Translate between the local (camelCase, nested GPS) shape and the server
// (snake_case, flat columns) shape.
import { SyncStatus, GpsSource } from '../db/models.js'

const geo = (lat, lng, source) => ({
  lat: lat ?? null,
  lng: lng ?? null,
  source: source || GpsSource.NONE,
  accuracy: null
})

export function toServerTask(t) {
  return {
    id: t.id,
    company_id: t.companyId ?? null,
    company_name: t.companyName ?? null,
    machine_id: t.machineId ?? null,
    machine_name: t.machineName ?? null,
    operator_id: t.operatorId ?? null,
    operator_name: t.operatorName,
    status: t.status,
    created_by: t.createdBy,
    start_mileage: t.startMileage,
    start_time: t.startTime,
    start_lat: t.startGps?.lat ?? null,
    start_lng: t.startGps?.lng ?? null,
    start_gps_source: t.startGps?.source ?? GpsSource.NONE,
    start_photo_id: t.startPhotoId,
    work_photo_id: t.workPhotoId,
    end_mileage: t.endMileage,
    end_time: t.endTime,
    end_lat: t.endGps?.lat ?? null,
    end_lng: t.endGps?.lng ?? null,
    end_gps_source: t.endGps?.source ?? GpsSource.NONE,
    end_work_photo_id: t.endWorkPhotoId ?? null,
    end_photo_id: t.endPhotoId,
    duration_minutes: t.durationMinutes,
    piece_rate_id: t.pieceRateId,
    piece_rate_name: t.pieceRateName,
    unit: t.unit,
    unit_price: t.unitPrice,
    quantity: t.quantity,
    quantity_expr: t.quantityExpr ?? null,
    amount: t.amount,
    area_id: t.areaId,
    area_name: t.areaName,
    notes: t.notes || '',
    day_key: t.dayKey,
    month_key: t.monthKey,
    created_at: t.createdAt,
    updated_at: t.updatedAt
  }
}

export function fromServerTask(r) {
  return {
    id: r.id,
    companyId: r.company_id ?? null,
    companyName: r.company_name ?? null,
    machineId: r.machine_id ?? null,
    machineName: r.machine_name ?? null,
    operatorId: r.operator_id ?? null,
    operatorName: r.operator_name,
    status: r.status,
    createdBy: r.created_by,
    startMileage: r.start_mileage,
    startTime: r.start_time,
    startGps: geo(r.start_lat, r.start_lng, r.start_gps_source),
    startPhotoId: r.start_photo_id,
    workPhotoId: r.work_photo_id,
    endMileage: r.end_mileage,
    endTime: r.end_time,
    endGps: geo(r.end_lat, r.end_lng, r.end_gps_source),
    endWorkPhotoId: r.end_work_photo_id ?? null,
    endPhotoId: r.end_photo_id,
    durationMinutes: r.duration_minutes,
    pieceRateId: r.piece_rate_id,
    pieceRateName: r.piece_rate_name,
    unit: r.unit,
    unitPrice: r.unit_price,
    quantity: r.quantity,
    quantityExpr: r.quantity_expr ?? null,
    amount: r.amount,
    areaId: r.area_id,
    areaName: r.area_name,
    notes: r.notes || '',
    dayKey: r.day_key,
    monthKey: r.month_key,
    serverId: r.id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerPhoto(p, storagePath) {
  return {
    id: p.id,
    task_id: p.taskId,
    kind: p.kind,
    storage_path: storagePath ?? p.storagePath ?? null,
    captured_at: p.capturedAt,
    lat: p.gps?.lat ?? null,
    lng: p.gps?.lng ?? null,
    gps_source: p.gps?.source ?? GpsSource.NONE,
    updated_at: p.updatedAt
  }
}

export function fromServerPhoto(r, existingBlob = null) {
  return {
    id: r.id,
    taskId: r.task_id,
    kind: r.kind,
    blob: existingBlob, // server never sends bytes back; keep local blob if any
    storagePath: r.storage_path,
    capturedAt: r.captured_at,
    gps: geo(r.lat, r.lng, r.gps_source),
    syncStatus: SyncStatus.SYNCED,
    updatedAt: r.updated_at
  }
}

export function toServerTrack(t) {
  return {
    id: t.id,
    operator_id: t.operatorId ?? null,
    operator_name: t.operatorName ?? null,
    task_id: t.taskId ?? null,
    piece_rate_id: t.pieceRateId ?? null,
    piece_rate_name: t.pieceRateName ?? null,
    company_id: t.companyId ?? null,
    points: t.points ?? [], // jsonb [{lat,lng,t}]
    distance_meters: t.distanceMeters ?? 0,
    started_at: t.startedAt,
    ended_at: t.endedAt,
    manual: !!t.manual, // drawn by an admin instead of GPS-recorded
    drawn_by: t.drawnBy ?? null,
    edited_by: t.editedBy ?? null, // set when an HQ admin reshaped a recording
    day_key: t.dayKey,
    month_key: t.monthKey,
    updated_at: t.updatedAt
  }
}
export function fromServerTrack(r) {
  return {
    id: r.id,
    operatorId: r.operator_id ?? null,
    operatorName: r.operator_name ?? null,
    taskId: r.task_id ?? null,
    pieceRateId: r.piece_rate_id ?? null,
    pieceRateName: r.piece_rate_name ?? null,
    companyId: r.company_id ?? null,
    points: r.points ?? [],
    distanceMeters: r.distance_meters ?? 0,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    manual: !!r.manual,
    drawnBy: r.drawn_by ?? null,
    editedBy: r.edited_by ?? null,
    dayKey: r.day_key,
    monthKey: r.month_key,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerCompany(c) {
  return {
    id: c.id,
    name: c.name,
    active: c.active,
    signers: c.signers ?? null,
    boundary: c.boundary ?? null, // uploaded KML/GPX site outline
    updated_at: c.updatedAt
  }
}
export function fromServerCompany(r) {
  return {
    id: r.id,
    name: r.name,
    active: r.active,
    signers: r.signers ?? null,
    boundary: r.boundary ?? null,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerMachine(m) {
  return {
    id: m.id,
    company_id: m.companyId ?? null,
    name: m.name,
    pin_hash: m.pinHash ?? null,
    active: m.active,
    updated_at: m.updatedAt
  }
}
export function fromServerMachine(r) {
  return {
    id: r.id,
    companyId: r.company_id ?? null,
    name: r.name,
    pinHash: r.pin_hash ?? null,
    active: r.active,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerPieceRate(p) {
  return {
    id: p.id,
    machine_id: p.machineId ?? null,
    name: p.name,
    unit: p.unit,
    price: p.price,
    active: p.active,
    updated_at: p.updatedAt
  }
}
export function fromServerPieceRate(r) {
  return {
    id: r.id,
    machineId: r.machine_id ?? null,
    name: r.name,
    unit: r.unit,
    price: r.price,
    active: r.active,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerOperator(o) {
  return {
    id: o.id,
    name: o.name,
    company_id: o.companyId ?? null,
    pin: o.pin ?? null,
    pin_hash: o.pinHash ?? null,
    active: o.active,
    is_site_admin: o.isSiteAdmin ?? false,
    basic_salary: o.basicSalary ?? null,
    phone_allowance: o.phoneAllowance ?? null,
    hourly_rate: o.hourlyRate ?? null,
    machine_ids: o.machineIds ?? [],
    force_logout_at: o.forceLogoutAt ?? null,
    updated_at: o.updatedAt
  }
}
export function fromServerOperator(r) {
  return {
    id: r.id,
    name: r.name,
    companyId: r.company_id ?? null,
    pin: r.pin ?? null,
    pinHash: r.pin_hash ?? null,
    active: r.active,
    isSiteAdmin: r.is_site_admin === true,
    basicSalary: r.basic_salary ?? null,
    phoneAllowance: r.phone_allowance ?? null,
    hourlyRate: r.hourly_rate ?? null,
    machineIds: Array.isArray(r.machine_ids) ? r.machine_ids : [],
    forceLogoutAt: r.force_logout_at ?? null,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerClaim(c) {
  return {
    id: c.id,
    operator_id: c.operatorId ?? null,
    month_key: c.monthKey ?? null,
    incentives: Array.isArray(c.incentives) ? c.incentives : [],
    updated_at: c.updatedAt
  }
}
export function fromServerClaim(r) {
  return {
    id: r.id,
    operatorId: r.operator_id ?? null,
    monthKey: r.month_key ?? null,
    incentives: Array.isArray(r.incentives) ? r.incentives : [],
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerMonthLock(l) {
  return { id: l.id, locked: !!l.locked, locked_at: l.lockedAt ?? null, updated_at: l.updatedAt }
}
export function fromServerMonthLock(r) {
  return {
    id: r.id,
    locked: !!r.locked,
    lockedAt: r.locked_at ?? null,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}

export function toServerArea(a) {
  return { id: a.id, company_id: a.companyId ?? null, name: a.name, active: a.active, updated_at: a.updatedAt }
}
export function fromServerArea(r) {
  return {
    id: r.id,
    companyId: r.company_id ?? null,
    name: r.name,
    active: r.active,
    updatedAt: r.updated_at,
    syncStatus: SyncStatus.SYNCED
  }
}
