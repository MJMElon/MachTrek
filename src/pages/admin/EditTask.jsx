import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  getTask,
  updateTask,
  deleteTask,
  listPieceRates,
  listAreas,
  listOperators,
  listMachines,
  listCompanies,
  isMonthLocked,
  kerjaJamRate,
  listTaskTracks,
  KERJA_JAM_ID
} from '../../db/repo.js'

// Read-only map view of the operator's GPS paths (loads Leaflet on demand).
const DistanceRecorder = lazy(() => import('../../components/DistanceRecorder.jsx'))
import { getMeta } from '../../db/database.js'
import { TaskStatus, GpsSource, HOURLY_RATE_NAME } from '../../db/models.js'
import { toLocalInput, fromLocalInput, formatMoney, formatRate, dayKeyOf, monthKeyOf, formatLatLng, parseLatLng } from '../../lib/format.js'
import { minutesBetween, formatHours } from '../../lib/duration.js'
import { useAuth } from '../../auth/AuthContext.jsx'
import PageHeader from '../../components/PageHeader.jsx'
import PhotoCapture from '../../components/PhotoCapture.jsx'
import { Button, Card, Field, NumberInput, TextInput, TextArea, Select, Spinner, Badge } from '../../components/ui.jsx'
import { QuantityInput } from '../../components/QuantityInput.jsx'
import { isDayUnit, DAY_QTY_CHOICES } from '../../lib/dashboard.js'
import { evalExpr, isExpression } from '../../lib/expr.js'
import { IconTrash, IconLock, IconWarning } from '../../components/icons.jsx'

const DUR_MODES = [
  ['time', 'Start/End'],
  ['meter', 'Hour meter'],
  ['hours', 'Hours']
]

const dateToISO = (d) => (d ? new Date(`${d}T00:00:00`).toISOString() : null)

function computeDur(f) {
  if (f.durMode === 'time') return minutesBetween(fromLocalInput(f.startTime), fromLocalInput(f.endTime))
  if (f.durMode === 'meter') {
    if (f.startMeter === '' || f.endMeter === '') return null
    const s = Number(f.startMeter)
    const e = Number(f.endMeter)
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null
    return Math.round((e - s) * 60)
  }
  if (f.durMode === 'hours') {
    if (f.hours === '') return null
    const h = Number(f.hours)
    if (!Number.isFinite(h) || h < 0) return null
    return Math.round(h * 60)
  }
  return null
}

export default function EditTask() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isSite = user.role === 'siteadmin'

  const task = useLiveQuery(() => getTask(id), [id], undefined)
  const operators = useLiveQuery(() => listOperators({ includeInactive: true }), [], [])
  const machines = useLiveQuery(() => listMachines({ includeInactive: true }), [], [])
  const companies = useLiveQuery(() => listCompanies({ includeInactive: true }), [], [])
  const currency = useLiveQuery(() => getMeta('currency', 'RM'), [], 'RM')
  const locked = useLiveQuery(() => isMonthLocked(task?.monthKey), [task?.monthKey], false)

  const [f, setF] = useState(null)
  const [mapOpen, setMapOpen] = useState(false)
  // GPS paths recorded by the operator for this task. When any exist the
  // quantity is the measured total and must stay read-only here — editing it
  // would break the audit trail back to the recorded paths.
  const taskTracks = useLiveQuery(() => listTaskTracks(id), [id], [])
  const trackTotal = useMemo(
    () => Math.round((taskTracks || []).reduce((s, t) => s + (Number(t.distanceMeters) || 0), 0) * 10) / 10,
    [taskTracks]
  )
  const qtyLocked = (taskTracks || []).length > 0
  const [showQtyFormula, setShowQtyFormula] = useState(false)
  const trackExpr = useMemo(
    () => (taskTracks || []).map((t) => Math.round((Number(t.distanceMeters) || 0) * 10) / 10).join('+'),
    [taskTracks]
  )
  const [startPhoto, setStartPhoto] = useState(null)
  const [workPhoto, setWorkPhoto] = useState(null)
  const [endWorkPhoto, setEndWorkPhoto] = useState(null)
  const [endPhoto, setEndPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)

  useEffect(() => {
    if (task && !f) {
      // Infer how the duration was originally entered so the matching mode opens.
      const durMode = task.endTime
        ? 'time'
        : task.startMileage != null && task.endMileage != null
          ? 'meter'
          : task.durationMinutes != null
            ? 'hours'
            : 'time'
      setF({
        operatorId: task.operatorId || '',
        machineId: task.machineId || '',
        status: task.status,
        durMode,
        startTime: toLocalInput(task.startTime),
        date: task.startTime ? dayKeyOf(task.startTime) : '',
        startLoc: formatLatLng(task.startGps?.lat, task.startGps?.lng),
        endTime: toLocalInput(task.endTime),
        endLoc: formatLatLng(task.endGps?.lat, task.endGps?.lng),
        startMeter: task.startMileage ?? '',
        endMeter: task.endMileage ?? '',
        hours: task.durationMinutes != null ? String(+(task.durationMinutes / 60).toFixed(2)) : '',
        rateId: task.pieceRateId || (task.pieceRateName === HOURLY_RATE_NAME ? KERJA_JAM_ID : ''),
        quantity: task.quantityExpr ?? (task.quantity != null ? String(task.quantity) : ''),
        areaId: task.areaId || '',
        notes: task.notes || ''
      })
    }
  }, [task, f])

  // A site admin may only edit records in their own company.
  useEffect(() => {
    if (isSite && task && task.companyId && task.companyId !== user.companyId) {
      navigate('/admin/records', { replace: true })
    }
  }, [isSite, task, user.companyId, navigate])

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }))

  // Return to the records list with the operator tab + month still selected, so
  // the admin keeps editing that operator in place (no jump to the first one).
  const backToRecords = (operatorId, monthKey) => {
    const qs = new URLSearchParams()
    if (operatorId) qs.set('operator', operatorId)
    if (monthKey) qs.set('month', monthKey)
    const s = qs.toString()
    navigate(s ? `/admin/records?${s}` : '/admin/records')
  }

  const availableOperators = useMemo(
    () => (operators || []).filter((o) => !o.isSiteAdmin && (!isSite || o.companyId === user.companyId)),
    [operators, isSite, user.companyId]
  )

  const rates = useLiveQuery(
    () => (f?.machineId ? listPieceRates({ machineId: f.machineId, includeInactive: true }) : Promise.resolve([])),
    [f?.machineId],
    []
  )
  const selectedOperator = useMemo(
    () => (operators || []).find((o) => o.id === f?.operatorId) || null,
    [operators, f?.operatorId]
  )
  // "Kerja jam" (the operator's hourly rate) is offered with the machine's rates.
  const rateOptions = useMemo(
    () => (f?.machineId ? [kerjaJamRate(selectedOperator), ...(rates || [])] : []),
    [f?.machineId, selectedOperator, rates]
  )
  const rate = useMemo(() => rateOptions.find((r) => r.id === f?.rateId) || null, [rateOptions, f?.rateId])
  // Limit to the machines assigned to this operator in Settings (their ticked
  // machines), in their company — but always keep the machine already on the
  // record selectable so an edit can't silently drop it.
  const opMachines = useMemo(() => {
    const ids = new Set(selectedOperator?.machineIds || [])
    const list = (machines || []).filter(
      (m) => ids.has(m.id) && (!selectedOperator?.companyId || m.companyId === selectedOperator.companyId)
    )
    if (f?.machineId && !list.some((m) => m.id === f.machineId)) {
      const cur = (machines || []).find((m) => m.id === f.machineId)
      if (cur) return [cur, ...list]
    }
    return list
  }, [machines, selectedOperator, f?.machineId])
  const areas = useLiveQuery(
    () =>
      selectedOperator?.companyId
        ? listAreas({ companyId: selectedOperator.companyId, includeInactive: true })
        : Promise.resolve([]),
    [selectedOperator?.companyId],
    []
  )
  const durationMins = f ? computeDur(f) : null
  const qtyNum = evalExpr(f?.quantity)
  const amount = rate && qtyNum != null ? qtyNum * Number(rate.price) : null

  if (task === undefined || !f) {
    return (
      <div className="flex justify-center py-20 text-brand">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (!task) {
    return (
      <div className="py-10 text-center text-slate-500">
        <p>Record not found.</p>
        <Button className="mt-4" onClick={() => navigate('/admin/records')}>
          Back to records
        </Button>
      </div>
    )
  }

  function gpsFor(loc, original) {
    const { lat, lng } = parseLatLng(loc)
    const changed = lat !== (original?.lat ?? null) || lng !== (original?.lng ?? null)
    return { lat, lng, source: changed ? GpsSource.MANUAL : original?.source || GpsSource.NONE, accuracy: null }
  }

  // Uploading a photo flips to Start/End mode and fills the time + location.
  function onPhoto(which, photo) {
    if (which === 'start') setStartPhoto(photo)
    else if (which === 'work') setWorkPhoto(photo)
    else if (which === 'endwork') setEndWorkPhoto(photo)
    else setEndPhoto(photo)
    if (!photo) return
    setF((p) => {
      const next = { ...p, durMode: 'time' }
      const isEnd = which === 'end' || which === 'endwork'
      if (photo.capturedAt) {
        if (isEnd) next.endTime = toLocalInput(photo.capturedAt)
        else next.startTime = toLocalInput(photo.capturedAt)
      }
      if (photo.gps?.lat != null) {
        const loc = formatLatLng(photo.gps.lat, photo.gps.lng)
        if (isEnd) next.endLoc = loc
        else next.startLoc = loc
      }
      return next
    })
  }

  async function save(e) {
    e.preventDefault()
    if (submitting.current) return
    setError('')
    const operator = (operators || []).find((o) => o.id === f.operatorId)
    if (!operator) return setError('Choose an operator.')
    const machine = (machines || []).find((m) => m.id === f.machineId) || null
    const company = (companies || []).find((c) => c.id === machine?.companyId) || null
    const area = (areas || []).find((a) => a.id === f.areaId) || null

    // Duration + start anchor come from the chosen mode.
    if (f.durMode === 'time' && !f.startTime) return setError('Choose a start time.')
    if (f.durMode !== 'time' && !f.date) return setError('Choose the date of the job.')
    const durationMinutes = computeDur(f)
    const startTime = f.durMode === 'time' ? fromLocalInput(f.startTime) : dateToISO(f.date)
    const endTime = f.durMode === 'time' ? fromLocalInput(f.endTime) : null
    const startMileage = f.durMode === 'meter' && f.startMeter !== '' ? Number(f.startMeter) : null
    const endMileage = f.durMode === 'meter' && f.endMeter !== '' ? Number(f.endMeter) : null

    // Managers may save incomplete records. The only hard rule for a completed
    // record is a machine (it sets the company); missing duration / piece rate is
    // allowed and just flagged with a warning. A typed quantity must still parse.
    if (f.status === TaskStatus.COMPLETED && !machine) {
      return setError('A completed record needs a machine.')
    }
    if (f.quantity.trim() !== '' && !(evalExpr(f.quantity) > 0)) {
      return setError('Quantity must be a number or sum greater than 0 (e.g. 5+5+10-6).')
    }

    const patch = {
      operatorId: operator.id,
      operatorName: operator.name,
      machineId: machine?.id ?? null,
      machineName: machine?.name ?? null,
      companyId: company?.id ?? machine?.companyId ?? null,
      companyName: company?.name ?? null,
      status: f.status,
      startTime,
      startGps: gpsFor(f.startLoc, task.startGps),
      endTime,
      endGps: gpsFor(f.endLoc, task.endGps),
      startMileage,
      endMileage,
      durationMinutes,
      pieceRateId: rate?.id ?? null,
      pieceRateName: rate?.name ?? null,
      unit: rate?.unit ?? null,
      unitPrice: rate ? Number(rate.price) : null,
      // GPS-measured quantities always come from the recordings themselves, not
      // the (possibly stale) form snapshot.
      quantity: qtyLocked ? trackTotal : evalExpr(f.quantity),
      quantityExpr: qtyLocked
        ? (taskTracks || []).length > 1
          ? trackExpr
          : null
        : isExpression(f.quantity)
          ? f.quantity.trim()
          : null,
      areaId: area?.id ?? null,
      areaName: area?.name ?? null,
      notes: f.notes
    }

    submitting.current = true
    setBusy(true)
    try {
      await updateTask(id, patch, { startPhoto, workPhoto, endWorkPhoto, endPhoto })
      // Follow the record to where it now lives — the operator and/or month may
      // have been changed in this edit — instead of snapping to the first operator.
      backToRecords(f.operatorId, startTime ? monthKeyOf(startTime) : task.monthKey)
    } catch (err) {
      setError(err.message || 'Could not save.')
      setBusy(false)
      submitting.current = false
    }
  }

  async function remove() {
    if (submitting.current) return
    if (!confirm('Delete this record permanently? This cannot be undone.')) return
    submitting.current = true
    setBusy(true)
    try {
      await deleteTask(id)
      backToRecords(task.operatorId, task.monthKey)
    } catch (err) {
      setError(err.message)
      setBusy(false)
      submitting.current = false
    }
  }


  return (
    <form onSubmit={save} className="pb-4">
      <PageHeader
        title="Edit record"
        subtitle={
          task.createdBy === 'admin'
            ? 'Added by HQ admin'
            : task.createdBy === 'siteadmin'
              ? 'Added by site admin'
              : 'From operator'
        }
        onBack={() => backToRecords(task.operatorId, task.monthKey)}
        right={<Badge color={task.status === 'completed' ? 'green' : 'amber'}>{task.status === 'completed' ? 'Completed' : 'Open'}</Badge>}
      />

      {locked && (
        <div className="mb-4 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700">
          <IconLock width={16} height={16} /> This month is locked. Unlock it in Payroll to edit or delete this record.
        </div>
      )}


      <Card className="space-y-4 p-4">
        <Field label="Operator" required>
          <Select
            value={f.operatorId}
            onChange={(e) => setF((p) => ({ ...p, operatorId: e.target.value, machineId: '', rateId: '', areaId: '' }))}
          >
            <option value="">Choose…</option>
            {availableOperators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.active ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Machine">
          <Select
            value={f.machineId}
            onChange={(e) => setF((p) => ({ ...p, machineId: e.target.value, rateId: '' }))}
            disabled={!f.operatorId}
          >
            <option value="">{f.operatorId ? 'None' : 'Pick an operator first'}</option>
            {opMachines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
                {m.active ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
          {f.operatorId && opMachines.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">No machines ticked for this operator — assign machines to them in Settings.</p>
          )}
        </Field>
        <Field label="Status">
          <Select value={f.status} onChange={set('status')}>
            <option value={TaskStatus.IN_PROGRESS}>Open (in progress)</option>
            <option value={TaskStatus.COMPLETED}>Completed</option>
          </Select>
        </Field>
      </Card>

      {/* Duration and Work are two sub-sections of one group, matching the
          Add work form. */}
      <section className="mt-4 rounded-2xl border border-slate-200 bg-slate-100 p-2">
        <div className="px-2 pb-2 pt-1">
          <h2 className="text-sm font-semibold text-slate-800">Work details</h2>
          <p className="text-xs text-slate-500">Duration and the piece rate for this record.</p>
        </div>
        <Card className="space-y-4 p-4">
          <h3 className="text-sm font-semibold text-slate-800">Duration</h3>
          <div>
            <p className="mb-1.5 text-sm font-medium text-slate-700">How is the duration set?</p>
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1">
              {DUR_MODES.map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setF((p) => ({ ...p, durMode: val }))}
                  className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                    f.durMode === val ? 'bg-white text-brand shadow-sm' : 'text-slate-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {f.durMode === 'time' && (
            <>
              <Field label="Start time">
                <TextInput type="datetime-local" step="1" value={f.startTime} onChange={set('startTime')} />
              </Field>
              <Field label="Start location" hint="Optional · latitude, longitude">
                <TextInput value={f.startLoc} onChange={set('startLoc')} placeholder="e.g. 3.13921, 101.6869" />
              </Field>
              <Field label="End time">
                <TextInput type="datetime-local" step="1" value={f.endTime} onChange={set('endTime')} />
              </Field>
              <Field label="End location" hint="Optional · latitude, longitude">
                <TextInput value={f.endLoc} onChange={set('endLoc')} placeholder="e.g. 3.13921, 101.6869" />
              </Field>
            </>
          )}

          {f.durMode === 'meter' && (
            <>
              <Field label="Tarikh kerja">
                <TextInput type="date" value={f.date} onChange={set('date')} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Start meter (hrs)">
                  <NumberInput value={f.startMeter} onChange={set('startMeter')} placeholder="e.g. 1240.5" />
                </Field>
                <Field label="End meter (hrs)">
                  <NumberInput value={f.endMeter} onChange={set('endMeter')} placeholder="e.g. 1243.0" />
                </Field>
              </div>
            </>
          )}

          {f.durMode === 'hours' && (
            <>
              <Field label="Tarikh kerja">
                <TextInput type="date" value={f.date} onChange={set('date')} />
              </Field>
              <Field label="Jam bekerja" hint="To 1 decimal, e.g. 2.5">
                <NumberInput value={f.hours} onChange={set('hours')} placeholder="e.g. 2.5" step="0.1" />
              </Field>
            </>
          )}

          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="text-slate-500">Duration (auto)</span>
            <span className="font-semibold text-slate-800">{formatHours(durationMins)}</span>
          </div>
        </Card>

        <Card className="mt-2 space-y-4 p-4">
          <h3 className="text-sm font-semibold text-slate-800">Work & rate</h3>
          <Field label="Piece rate" hint={f.machineId ? undefined : 'Choose a machine first'}>
            <Select value={f.rateId} onChange={set('rateId')} disabled={!f.machineId}>
              <option value="">None</option>
              {rateOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} — {formatRate(r.price, currency)}/{r.unit}
                  {r.active ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          </Field>
          {/* Paths for this task. Also shown when there are none yet, so a manager
              can open the map and draw the first one. */}
          {((taskTracks || []).length > 0 || !locked) && (
            <button
              type="button"
              onClick={() => setMapOpen(true)}
              className="flex w-full items-center justify-between rounded-xl border border-brand/40 bg-brand-light/50 px-3 py-3 text-left active:bg-brand-light"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brand-dark">GPS distance recording</p>
                <p className="text-xs text-slate-600">
                  {(taskTracks || []).length > 0
                    ? `${taskTracks.length} recording${taskTracks.length === 1 ? '' : 's'} · ${trackTotal.toLocaleString()} m measured`
                    : 'No paths yet — open the map to draw one'}
                </p>
              </div>
              <span className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white">
                {(taskTracks || []).length > 0 ? 'View map' : 'Open map'}
              </span>
            </button>
          )}

          <Field
            label={`Quantity${rate ? ` (${rate.unit})` : ''}`}
            hint={
              qtyLocked
                ? 'Measured by GPS — tap to see the sum'
                : rate && isDayUnit(rate.unit)
                  ? 'Half day or full day'
                  : 'A number or a sum like 5+5+10-6'
            }
          >
            {rate && isDayUnit(rate.unit) && !qtyLocked ? (
              // Day work is only ever half a day or a whole day.
              <Select value={f.quantity} onChange={set('quantity')}>
                <option value="">Choose…</option>
                {DAY_QTY_CHOICES.map((v) => (
                  <option key={v} value={v}>
                    {v} hari
                  </option>
                ))}
              </Select>
            ) : qtyLocked ? (
              // Excel-cell style: total, tap to reveal the recordings' sum. Not
              // editable — the value belongs to the GPS recordings.
              <button
                type="button"
                onClick={() => setShowQtyFormula((v) => !v)}
                className="flex h-12 w-full items-center rounded-xl border border-slate-300 bg-slate-100 px-3.5 text-left font-semibold text-slate-800"
              >
                {showQtyFormula ? trackExpr : `${trackTotal.toLocaleString()} m`}
              </button>
            ) : (
              <QuantityInput value={f.quantity} onChange={(v) => setF((p) => ({ ...p, quantity: v }))} />
            )}
          </Field>
          <Field label="Area">
            <Select value={f.areaId} onChange={set('areaId')}>
              <option value="">None</option>
              {(areas || []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.active ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes">
            <TextArea value={f.notes} onChange={set('notes')} />
          </Field>
          {amount != null && (
            <div className="flex items-center justify-between rounded-lg bg-brand-light px-3 py-2">
              <span className="text-sm text-brand-dark">Amount</span>
              <span className="font-bold text-brand-dark">{formatMoney(amount, currency)}</span>
            </div>
          )}
        </Card>
      </section>

      {/* One photo section: tiles show what's on the record; tap the caption to
          replace (with a confirm), tap the image to view it full screen. */}
      <Card className="mt-4 p-4">
        <p className="mb-1 text-sm font-medium text-slate-700">Photos</p>
        <p className="mb-2 text-xs text-slate-500">
          Tap a photo to view · tap its label to replace. A new photo sets Start/End mode and fills the time + location.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <PhotoCapture
            compact
            confirmReplace
            label="Start meter"
            existingId={task.startPhotoId}
            value={startPhoto}
            onChange={(p) => onPhoto('start', p)}
          />
          <PhotoCapture
            compact
            confirmReplace
            label="Start photo 2"
            existingId={task.workPhotoId}
            value={workPhoto}
            onChange={(p) => onPhoto('work', p)}
          />
          <PhotoCapture
            compact
            confirmReplace
            label="Proof of work"
            existingId={task.endWorkPhotoId}
            value={endWorkPhoto}
            onChange={(p) => onPhoto('endwork', p)}
          />
          <PhotoCapture
            compact
            confirmReplace
            label="End meter"
            existingId={task.endPhotoId}
            value={endPhoto}
            onChange={(p) => onPhoto('end', p)}
          />
        </div>
      </Card>

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      {(durationMins == null || !rate) && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <IconWarning width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            Incomplete record — missing{' '}
            {[durationMins == null ? 'duration' : null, !rate ? 'work type (piece rate)' : null]
              .filter(Boolean)
              .join(' and ')}
            . You can still save.
          </span>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <Button full type="submit" disabled={busy || locked}>
          {busy ? 'Saving…' : locked ? 'Locked' : 'Save changes'}
        </Button>
        <Button full type="button" variant="danger" onClick={remove} disabled={busy || locked}>
          <IconTrash width={18} height={18} /> Delete record
        </Button>
      </div>


      {/* Operator's recorded GPS paths — view + export only, no recording. */}
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
            readOnly
            tracks={taskTracks || []}
            boundary={(companies || []).find((c) => c.id === task.companyId)?.boundary || null}
            title={`${task.operatorName || 'Operator'} · ${task.pieceRateName || 'Work'}`}
            // Site + HQ admin may draw a path; only HQ admin may delete one.
            canDraw={!locked}
            canDelete={user?.role === 'admin' && !locked}
            canEditRecorded={user?.role === 'admin' && !locked}
            editedBy={user?.role === 'admin' ? 'HQ admin' : 'Site admin'}
            // With no paths yet, open on this record's own GPS position.
            focus={
              task.startGps?.lat != null
                ? [task.startGps.lat, task.startGps.lng]
                : task.endGps?.lat != null
                  ? [task.endGps.lat, task.endGps.lng]
                  : null
            }
            drawTarget={
              locked
                ? null
                : {
                    taskId: id,
                    session: {
                      operatorId: task.operatorId,
                      operatorName: task.operatorName,
                      companyId: task.companyId
                    },
                    pieceRate: rate,
                    // Role, not the person — that's what matters for audit.
                    drawnBy: user?.role === 'admin' ? 'HQ admin' : 'Site admin'
                  }
            }
            onClose={() => setMapOpen(false)}
          />
        </Suspense>
      )}
    </form>
  )
}

