// Shared enums and type shapes for the whole app.
// (Plain JS + JSDoc so editors give autocomplete without a TS build step.)

export const TaskStatus = {
  IN_PROGRESS: 'in_progress', // started (has photos/mileage) but not yet completed
  COMPLETED: 'completed' // has end mileage + piece rate + quantity + area
}

export const SyncStatus = {
  PENDING: 'pending', // saved locally, not yet pushed to Supabase
  SYNCED: 'synced', // present on the server
  ERROR: 'error' // last push attempt failed
}

export const PhotoKind = {
  START_MILEAGE: 'start_mileage',
  WORK: 'work',
  END_WORK: 'end_work', // proof-of-work photo taken when finishing
  END_MILEAGE: 'end_mileage',
  EXTRA: 'extra'
}

export const GpsSource = {
  EXIF: 'exif', // read from the photo file's embedded metadata
  DEVICE: 'device', // read from the live device GPS at capture time
  MANUAL: 'manual', // typed/edited by an admin
  NONE: 'none' // unavailable
}

export const Role = {
  OPERATOR: 'operator',
  ADMIN: 'admin', // system admin (password) — manages everything
  SITEADMIN: 'siteadmin' // a company supervisor; logs in like an operator
}

export const CreatedBy = {
  OPERATOR: 'operator',
  ADMIN: 'admin', // system admin manual entry
  SITEADMIN: 'siteadmin' // a company site admin entered it (shown like operator work)
}

// A default piece rate seeded on every machine. Its price is the machine's
// hourly work rate, used by the dashboard to compute the "old system" salary
// (everything paid by the hour).
export const HOURLY_RATE_NAME = 'Kerja jam'
export const HOURLY_RATE_UNIT = 'jam'

/**
 * @typedef {Object} GeoPoint
 * @property {number|null} lat
 * @property {number|null} lng
 * @property {string} source - one of GpsSource
 * @property {number|null} [accuracy] - metres, when from device GPS
 */

/**
 * @typedef {Object} Operator
 * @property {string} id
 * @property {string} name
 * @property {string} [pinHash]
 * @property {boolean} active
 * @property {string} updatedAt
 * @property {string} syncStatus
 */

/**
 * @typedef {Object} PieceRate
 * @property {string} id
 * @property {string} name      - e.g. "Repair road"
 * @property {string} unit      - e.g. "m", "m2", "ton", "trip"
 * @property {number} price     - price per one unit
 * @property {boolean} active
 * @property {string} updatedAt
 * @property {string} syncStatus
 */

/**
 * @typedef {Object} Area
 * @property {string} id
 * @property {string} name
 * @property {boolean} active
 * @property {string} updatedAt
 * @property {string} syncStatus
 */

/**
 * @typedef {Object} Photo
 * @property {string} id
 * @property {string} taskId
 * @property {string} kind        - one of PhotoKind
 * @property {Blob}   [blob]      - the image bytes (local only)
 * @property {string} [storagePath] - path in the Supabase Storage bucket once uploaded
 * @property {string|null} capturedAt - ISO timestamp chosen for this photo
 * @property {GeoPoint} gps
 * @property {string} syncStatus
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} operatorId
 * @property {string} operatorName
 * @property {string} status        - one of TaskStatus
 * @property {string} createdBy      - one of CreatedBy
 *
 * @property {number|null} startMileage
 * @property {string|null} startTime  - ISO; drives duration
 * @property {GeoPoint}    startGps
 * @property {string|null} startPhotoId
 * @property {string|null} workPhotoId
 *
 * @property {number|null} endMileage
 * @property {string|null} endTime    - ISO; drives duration
 * @property {GeoPoint}    endGps
 * @property {string|null} endWorkPhotoId - proof-of-work photo at completion
 * @property {string|null} endPhotoId     - ending mileage/meter photo
 *
 * @property {number|null} durationMinutes
 *
 * @property {string|null} pieceRateId
 * @property {string|null} pieceRateName - snapshot at completion time
 * @property {string|null} unit          - snapshot
 * @property {number|null} unitPrice     - snapshot (price per unit)
 * @property {number|null} quantity      - units of work done
 * @property {string|null} [quantityExpr] - raw formula entered (e.g. "5+5+10-6"), if any
 * @property {number|null} amount        - quantity * unitPrice (snapshot)
 *
 * @property {string|null} areaId
 * @property {string|null} areaName      - snapshot
 *
 * @property {string} [notes]
 * @property {string} dayKey    - "YYYY-MM-DD" of startTime (or created date)
 * @property {string} monthKey  - "YYYY-MM"
 *
 * @property {string} syncStatus
 * @property {string|null} serverId
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} Track
 * GPS distance recording made on the map while finishing a meter-unit task.
 * @property {string} id
 * @property {string} operatorId
 * @property {string|null} operatorName - snapshot
 * @property {string|null} taskId       - the task being finished when recorded
 * @property {string|null} pieceRateId
 * @property {string|null} pieceRateName - snapshot
 * @property {string|null} companyId
 * @property {Array<{lat:number,lng:number,t:number}>} points
 * @property {number} distanceMeters   - haversine sum over points (rounded 1dp)
 * @property {string} startedAt        - ISO
 * @property {string} endedAt          - ISO
 * @property {string} dayKey           - "YYYY-MM-DD" of startedAt
 * @property {string} monthKey         - "YYYY-MM" (retention + monthly export)
 * @property {string} syncStatus
 * @property {string} updatedAt
 */

export const emptyGeo = () => ({ lat: null, lng: null, source: GpsSource.NONE, accuracy: null })
