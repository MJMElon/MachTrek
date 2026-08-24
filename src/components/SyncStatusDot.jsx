import { SyncStatus } from '../db/models.js'

const MAP = {
  [SyncStatus.SYNCED]: { c: 'bg-green-400', t: 'Synced' },
  [SyncStatus.PENDING]: { c: 'bg-amber-400', t: 'Waiting to sync' },
  [SyncStatus.ERROR]: { c: 'bg-red-400', t: 'Sync error' }
}

export function SyncStatusDot({ status, language = 'en' }) {
  const s = MAP[status] || MAP[SyncStatus.PENDING]
  const ms = {
    [SyncStatus.SYNCED]: 'Sudah sync',
    [SyncStatus.PENDING]: 'Menunggu segerak',
    [SyncStatus.ERROR]: 'Ralat segerak'
  }
  const label = language === 'ms' ? ms[status] || ms[SyncStatus.PENDING] : s.t
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${s.c}`} title={label} aria-label={label} />
}
