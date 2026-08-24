import { lazy, Suspense, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext.jsx'
import { getCompany, getMonthTasks, listTracks } from '../../db/repo.js'
import { getMeta } from '../../db/database.js'
import { monthKeyOf, monthLabel } from '../../lib/format.js'
import MonthSummary from '../../components/MonthSummary.jsx'
import { Button, Spinner } from '../../components/ui.jsx'
import { IconPin } from '../../components/icons.jsx'

// Read-only monthly map; keep Leaflet out of the initial operator summary load.
const DistanceRecorder = lazy(() => import('../../components/DistanceRecorder.jsx'))

export default function OperatorSummary() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [monthKey, setMonthKey] = useState(monthKeyOf(new Date()))
  const [mapOpen, setMapOpen] = useState(false)

  const tasks = useLiveQuery(
    () => getMonthTasks({ operatorId: user.operatorId, monthKey }),
    [user.operatorId, monthKey],
    undefined
  )
  const tracks = useLiveQuery(
    () => listTracks({ operatorId: user.operatorId, monthKey }),
    [user.operatorId, monthKey],
    []
  )
  const company = useLiveQuery(() => getCompany(user.companyId), [user.companyId], null)
  const currency = useLiveQuery(() => getMeta('currency', 'RM'), [], 'RM')

  const mapFocus = (() => {
    for (let i = (tasks || []).length - 1; i >= 0; i--) {
      const task = tasks[i]
      if (task.startGps?.lat != null) return [task.startGps.lat, task.startGps.lng]
      if (task.endGps?.lat != null) return [task.endGps.lat, task.endGps.lng]
    }
    return null
  })()

  return (
    <div className="pb-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-bold text-slate-800">Tuntutan gaji</h1>
          <p className="truncate text-xs text-slate-500">{user.operatorName}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => setMapOpen(true)}
          aria-label={`Lihat trek ${monthLabel(monthKey, 'ms-MY')}`}
        >
          <IconPin width={18} height={18} /> Peta
        </Button>
      </div>
      <MonthSummary
        tasks={tasks || []}
        monthKey={monthKey}
        onMonthChange={setMonthKey}
        currency={currency}
        onOpenClick={(t) => navigate(`/open/${t.id}`)}
        language="ms"
      />

      {mapOpen && (
        <Suspense
          fallback={
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 text-white">
              <Spinner className="h-8 w-8" />
            </div>
          }
        >
          <DistanceRecorder
            open={mapOpen}
            onClose={() => setMapOpen(false)}
            readOnly
            tracks={tracks || []}
            boundary={company?.boundary || null}
            title={`${monthLabel(monthKey, 'ms-MY')} · ${(tracks || []).length} rekod`}
            focus={mapFocus}
            language="ms"
          />
        </Suspense>
      )}
    </div>
  )
}
