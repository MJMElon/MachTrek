import { useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { addManualTask, listAreas, listOperators, listMachines, listCompanies, listPieceRates, kerjaJamRate } from '../../db/repo.js'
import { getMeta } from '../../db/database.js'
import { CreatedBy, GpsSource } from '../../db/models.js'
import { fromLocalInput, toLocalInput, formatMoney, formatRate, formatLatLng, parseLatLng } from '../../lib/format.js'

const geoFor = (loc, fallback) => {
  const { lat, lng } = parseLatLng(loc)
  if (lat == null && lng == null) return fallback || undefined
  const changed = lat !== (fallback?.lat ?? null) || lng !== (fallback?.lng ?? null)
  return { lat, lng, source: changed ? GpsSource.MANUAL : fallback?.source || GpsSource.DEVICE, accuracy: fallback?.accuracy ?? null }
}
import { minutesBetween, formatHours } from '../../lib/duration.js'
import { uuid } from '../../lib/uuid.js'
import { useAuth } from '../../auth/AuthContext.jsx'
import PageHeader from '../../components/PageHeader.jsx'
import PhotoCapture from '../../components/PhotoCapture.jsx'
import { Button, Card, Field, NumberInput, TextInput, TextArea, Select } from '../../components/ui.jsx'
import { QuantityInput } from '../../components/QuantityInput.jsx'
import { isDayUnit, DAY_QTY_CHOICES } from '../../lib/dashboard.js'
import { evalExpr, isExpression } from '../../lib/expr.js'
import { IconWarning } from '../../components/icons.jsx'

const dateToISO = (d) => (d ? new Date(`${d}T00:00:00`).toISOString() : null)

// One "Work details" group: its own duration + piece rate. Operator, machine and
// photos live outside this, because they are shared by every entry on the form.
const emptyEntry = (carry = {}) => ({
  key: uuid(),
  durMode: carry.durMode || 'time',
  startTime: '',
  endTime: '',
  startLoc: '',
  endLoc: '',
  date: carry.date || '',
  startMeter: '',
  endMeter: '',
  hours: '',
  rateId: '',
  quantity: '',
  areaId: '',
  notes: ''
})

function computeDuration(f) {
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

/**
 * Turn one entry into the timing half of an addManualTask() call, or an error
 * message. Every entry is checked before ANY of them is written, so a mistake
 * in the third entry can't leave the first two already saved.
 */
function prepareEntry(b) {
  if (b.quantity.trim() !== '' && !(evalExpr(b.quantity) > 0)) {
    return { error: 'Quantity must be a number or sum greater than 0 (e.g. 5+5+10-6).' }
  }

  let startTime
  let endTime = null
  let durationMinutes
  let startMileage
  let endMileage

  if (b.durMode === 'time') {
    if (!b.startTime) return { error: 'Choose a start time.' }
    startTime = fromLocalInput(b.startTime)
    endTime = fromLocalInput(b.endTime)
    durationMinutes = undefined // repo derives from times
  } else {
    if (!b.date) return { error: 'Choose the date of the job.' }
    startTime = dateToISO(b.date)
    // Duration is optional (managers may save incomplete) — only validate +
    // compute it when the readings/hours are actually provided.
    if (b.durMode === 'meter') {
      if (b.startMeter !== '' && b.endMeter !== '') {
        if (Number(b.endMeter) < Number(b.startMeter)) return { error: 'End meter must be at least the start meter.' }
        startMileage = b.startMeter
        endMileage = b.endMeter
        durationMinutes = Math.round((Number(b.endMeter) - Number(b.startMeter)) * 60)
      }
    } else if (b.hours !== '' && Number(b.hours) > 0) {
      durationMinutes = Math.round(Number(b.hours) * 60)
    }
  }
  return { entry: { b, startTime, endTime, durationMinutes, startMileage, endMileage } }
}

const DUR_MODES = [
  ['time', 'Start/End'],
  ['meter', 'Hour meter'],
  ['hours', 'Hours']
]

export default function AddTask() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const isSite = user.role === 'siteadmin'
  // Only HQ admin keys several jobs in one pass; a site admin gets the single
  // entry form exactly as before.
  const isHq = user.role === 'admin'
  const [searchParams] = useSearchParams()
  const presetOperatorId = searchParams.get('operator') || '' // set when coming from a record tab
  const presetMonth = searchParams.get('month') || '' // the month tab the admin was viewing

  const operators = useLiveQuery(() => listOperators({ includeInactive: true }), [], [])
  const machines = useLiveQuery(() => listMachines({ includeInactive: true }), [], [])
  const companies = useLiveQuery(() => listCompanies({ includeInactive: true }), [], [])
  const currency = useLiveQuery(() => getMeta('currency', 'RM'), [], 'RM')

  // Shared by every entry saved from this form.
  const [shared, setShared] = useState({ operatorId: presetOperatorId, machineId: '' })
  const [entries, setEntries] = useState(() => [emptyEntry()])
  const setEntry = (key, patch) => setEntries((es) => es.map((b) => (b.key === key ? { ...b, ...patch } : b)))
  const field = (key, name) => (e) => setEntry(key, { [name]: e.target.value })

  const [startPhoto, setStartPhoto] = useState(null)
  const [workPhoto, setWorkPhoto] = useState(null)
  const [endWorkPhoto, setEndWorkPhoto] = useState(null)
  const [endPhoto, setEndPhoto] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)

  // Where the back / Done buttons go — keep the operator's tab AND month in view
  // on return, so several jobs can be added in a row without re-navigating.
  const backToRecords = () => {
    const qs = new URLSearchParams()
    if (presetOperatorId) qs.set('operator', presetOperatorId)
    if (presetMonth) qs.set('month', presetMonth)
    const s = qs.toString()
    navigate(s ? `/admin/records?${s}` : '/admin/records')
  }

  // Operators selectable here: real workers, and (for a site admin) only their company.
  const availableOperators = useMemo(
    () => (operators || []).filter((o) => !o.isSiteAdmin && (!isSite || o.companyId === user.companyId)),
    [operators, isSite, user.companyId]
  )
  const selectedOperator = useMemo(
    () => (operators || []).find((o) => o.id === shared.operatorId) || null,
    [operators, shared.operatorId]
  )
  // Only the machines ticked for this operator in Settings (their assignment),
  // active and in their company — the same set the operator sees when completing
  // their own work, so an admin entry can't use a machine they aren't assigned.
  const opMachines = useMemo(() => {
    const ids = new Set(selectedOperator?.machineIds || [])
    return (machines || []).filter(
      (m) => m.active && ids.has(m.id) && (!selectedOperator?.companyId || m.companyId === selectedOperator.companyId)
    )
  }, [machines, selectedOperator])
  const areas = useLiveQuery(
    () => (selectedOperator?.companyId ? listAreas({ companyId: selectedOperator.companyId }) : Promise.resolve([])),
    [selectedOperator?.companyId],
    []
  )
  const rates = useLiveQuery(
    () => (shared.machineId ? listPieceRates({ machineId: shared.machineId }) : Promise.resolve([])),
    [shared.machineId],
    []
  )
  // "Kerja jam" (the chosen operator's hourly rate) is offered with the machine's rates.
  const rateOptions = useMemo(
    () => (shared.machineId ? [kerjaJamRate(selectedOperator), ...(rates || [])] : []),
    [shared.machineId, selectedOperator, rates]
  )

  // Per-entry derived values, in the same order as `entries`.
  const derived = useMemo(
    () =>
      entries.map((b) => {
        const rate = rateOptions.find((r) => r.id === b.rateId) || null
        const qtyNum = evalExpr(b.quantity)
        return {
          rate,
          qtyNum,
          durationMins: computeDuration(b),
          amount: rate && qtyNum != null ? qtyNum * Number(rate.price) : null
        }
      }),
    [entries, rateOptions]
  )
  const total = derived.reduce((sum, d) => (d.amount == null ? sum : sum + d.amount), 0)
  const anyAmount = derived.some((d) => d.amount != null)
  const incomplete = derived
    .map((d, i) => (d.durationMins == null || !d.rate ? i + 1 : null))
    .filter((n) => n !== null)

  const addEntry = () =>
    setEntries((es) => {
      const last = es[es.length - 1]
      // Carry the measurement style and date forward: the next job is nearly
      // always the same day, keyed the same way. Everything else starts blank.
      return [...es, emptyEntry({ durMode: last?.durMode, date: last?.date })]
    })
  const removeEntry = (key) => setEntries((es) => (es.length > 1 ? es.filter((b) => b.key !== key) : es))

  // Uploading a photo flips the duration to Start/End mode and fills the time
  // from the photo's EXIF timestamp (its GPS is applied automatically on save).
  // Photos belong to the first entry, so that is the one it fills in.
  function onPhoto(which, photo) {
    if (which === 'start') setStartPhoto(photo)
    else if (which === 'work') setWorkPhoto(photo)
    else if (which === 'endwork') setEndWorkPhoto(photo)
    else setEndPhoto(photo)
    if (!photo) return
    const isEnd = which === 'end' || which === 'endwork'
    setEntries((es) =>
      es.map((b, i) => {
        if (i !== 0) return b
        const next = { ...b, durMode: 'time' }
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
    )
  }

  async function save(e) {
    e.preventDefault()
    if (submitting.current) return
    setError('')
    const operator = (operators || []).find((o) => o.id === shared.operatorId)
    if (!operator) return setError('Choose an operator.')
    const machine = (machines || []).find((m) => m.id === shared.machineId)
    if (!machine) return setError('Choose a machine.')

    // Validate every entry up front — nothing is written until all of them pass.
    const prepared = []
    for (let i = 0; i < entries.length; i++) {
      const { entry, error: err } = prepareEntry(entries[i])
      if (err) return setError(entries.length > 1 ? `Work details ${i + 1}: ${err}` : err)
      prepared.push(entry)
    }

    const company = (companies || []).find((c) => c.id === machine.companyId) || null

    submitting.current = true
    setBusy(true)
    const saved = []
    try {
      for (let i = 0; i < prepared.length; i++) {
        const { b, startTime, endTime, durationMinutes, startMileage, endMileage } = prepared[i]
        // Each entry becomes its own record. Only operator, machine and company
        // are shared; the photos stay on the first record rather than being
        // duplicated onto jobs they were not taken for.
        const first = i === 0
        await addManualTask({
          operator,
          machine,
          company,
          // Site-admin entries are shown like operator work (green), not "Admin".
          createdBy: isSite ? CreatedBy.SITEADMIN : CreatedBy.ADMIN,
          startTime,
          endTime,
          durationMinutes,
          startMileage,
          endMileage,
          startGps: geoFor(b.startLoc, first ? startPhoto?.gps || workPhoto?.gps : null),
          endGps: geoFor(b.endLoc, first ? endPhoto?.gps || endWorkPhoto?.gps : null),
          pieceRate: rateOptions.find((r) => r.id === b.rateId) || null,
          quantity: evalExpr(b.quantity),
          quantityExpr: isExpression(b.quantity) ? b.quantity.trim() : null,
          area: (areas || []).find((a) => a.id === b.areaId) || null,
          notes: b.notes,
          startPhoto: first ? startPhoto : null,
          workPhoto: first ? workPhoto : null,
          endWorkPhoto: first ? endWorkPhoto : null,
          endPhoto: first ? endPhoto : null
        })
        saved.push(b.key)
      }
      // Return to records on the SAME operator's tab so several jobs can be
      // added in a row without re-selecting the operator each time.
      backToRecords()
    } catch (err) {
      // Drop the entries that did save, so retrying can't duplicate them.
      if (saved.length) setEntries((es) => es.filter((b) => !saved.includes(b.key)))
      setError(
        saved.length
          ? `Saved ${saved.length} of ${prepared.length} entries, then failed: ${err.message || 'Could not save.'}`
          : err.message || 'Could not save.'
      )
      setBusy(false)
      submitting.current = false
    }
  }

  return (
    <form onSubmit={save} className="pb-4">
      <PageHeader title="Add work" subtitle="Manual entry" onBack={backToRecords} />

      <Card className="space-y-4 p-4">
        <Field label="Operator" required>
          {presetOperatorId ? (
            <div className="flex h-12 items-center rounded-xl border border-slate-200 bg-slate-50 px-3.5 font-medium text-slate-800">
              {selectedOperator?.name || '—'}
            </div>
          ) : (
            <Select
              value={shared.operatorId}
              onChange={(e) => {
                setShared({ operatorId: e.target.value, machineId: '' })
                // Rates and areas both depend on the operator — clear them everywhere.
                setEntries((es) => es.map((b) => ({ ...b, rateId: '', areaId: '' })))
              }}
            >
              <option value="">Choose…</option>
              {availableOperators.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Machine" required>
          <Select
            value={shared.machineId}
            onChange={(e) => {
              setShared((p) => ({ ...p, machineId: e.target.value }))
              setEntries((es) => es.map((b) => ({ ...b, rateId: '' })))
            }}
            disabled={!shared.operatorId}
          >
            <option value="">{shared.operatorId ? 'Choose…' : 'Pick an operator first'}</option>
            {opMachines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          {shared.operatorId && opMachines.length === 0 && (
            <p className="mt-1 text-xs text-amber-600">No machines ticked for this operator — assign machines to them in Settings.</p>
          )}
        </Field>
      </Card>

      {/* One group per record. Duration and Work are two sub-sections of it, so
          the form does not read as a run of unrelated cards. */}
      {entries.map((b, i) => {
        const d = derived[i]
        const many = entries.length > 1
        return (
          <section key={b.key} className="mt-4 rounded-2xl border border-slate-200 bg-slate-100 p-2">
            <div className="flex items-start justify-between gap-2 px-2 pb-2 pt-1">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-slate-800">Work details{many ? ` ${i + 1}` : ''}</h2>
                <p className="text-xs text-slate-500">
                  {i === 0
                    ? 'Duration and the piece rate for this record.'
                    : 'Saved as its own record — same operator and machine.'}
                </p>
              </div>
              {many && (
                <button
                  type="button"
                  onClick={() => removeEntry(b.key)}
                  className="-mr-1 -mt-1 h-11 shrink-0 rounded-lg px-3 text-sm font-medium text-slate-500 active:bg-slate-200"
                >
                  Remove
                </button>
              )}
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
                      onClick={() => setEntry(b.key, { durMode: val })}
                      className={`rounded-lg py-2 text-sm font-medium transition-colors ${
                        b.durMode === val ? 'bg-white text-brand shadow-sm' : 'text-slate-500'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {b.durMode === 'time' && (
                <>
                  <Field label="Start time" required>
                    <TextInput type="datetime-local" step="1" value={b.startTime} onChange={field(b.key, 'startTime')} />
                  </Field>
                  <Field label="Start location" hint="Optional · latitude, longitude">
                    <TextInput value={b.startLoc} onChange={field(b.key, 'startLoc')} placeholder="e.g. 3.13921, 101.6869" />
                  </Field>
                  <Field label="End time">
                    <TextInput type="datetime-local" step="1" value={b.endTime} onChange={field(b.key, 'endTime')} />
                  </Field>
                  <Field label="End location" hint="Optional · latitude, longitude">
                    <TextInput value={b.endLoc} onChange={field(b.key, 'endLoc')} placeholder="e.g. 3.13921, 101.6869" />
                  </Field>
                </>
              )}

              {b.durMode === 'meter' && (
                <>
                  <Field label="Tarikh kerja" required>
                    <TextInput type="date" value={b.date} onChange={field(b.key, 'date')} />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Start meter (hrs)" required>
                      <NumberInput value={b.startMeter} onChange={field(b.key, 'startMeter')} placeholder="e.g. 1240.5" />
                    </Field>
                    <Field label="End meter (hrs)" required>
                      <NumberInput value={b.endMeter} onChange={field(b.key, 'endMeter')} placeholder="e.g. 1243.0" />
                    </Field>
                  </div>
                </>
              )}

              {b.durMode === 'hours' && (
                <>
                  <Field label="Tarikh kerja" required>
                    <TextInput type="date" value={b.date} onChange={field(b.key, 'date')} />
                  </Field>
                  <Field label="Jam bekerja" required hint="To 1 decimal, e.g. 2.5">
                    <NumberInput value={b.hours} onChange={field(b.key, 'hours')} placeholder="e.g. 2.5" step="0.1" />
                  </Field>
                </>
              )}

              <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                <span className="text-slate-500">Duration (auto)</span>
                <span className="font-semibold text-slate-800">
                  {d.durationMins == null ? '—' : formatHours(d.durationMins)}
                </span>
              </div>
            </Card>

            <Card className="mt-2 space-y-4 p-4">
              <h3 className="text-sm font-semibold text-slate-800">Work &amp; rate</h3>
              <Field label="Piece rate work" hint={shared.machineId ? 'Optional' : 'Choose a machine first'}>
                <Select value={b.rateId} onChange={field(b.key, 'rateId')} disabled={!shared.machineId}>
                  <option value="">{shared.machineId ? 'Choose work type…' : 'Pick a machine first'}</option>
                  {rateOptions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} — {formatRate(r.price, currency)}/{r.unit}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label={`Quantity${d.rate ? ` (${d.rate.unit})` : ''}`}
                hint={d.rate && isDayUnit(d.rate.unit) ? 'Half day or full day' : 'Optional — a number or a sum like 5+5+10-6'}
              >
                {d.rate && isDayUnit(d.rate.unit) ? (
                  // Day work is only ever half a day or a whole day.
                  <Select value={b.quantity} onChange={field(b.key, 'quantity')}>
                    <option value="">Choose…</option>
                    {DAY_QTY_CHOICES.map((v) => (
                      <option key={v} value={v}>
                        {v} hari
                      </option>
                    ))}
                  </Select>
                ) : (
                  <QuantityInput value={b.quantity} onChange={(v) => setEntry(b.key, { quantity: v })} />
                )}
              </Field>
              <Field label="Area">
                <Select value={b.areaId} onChange={field(b.key, 'areaId')}>
                  <option value="">Choose area…</option>
                  {(areas || []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Notes (optional)">
                <TextArea value={b.notes} onChange={field(b.key, 'notes')} />
              </Field>
              {d.amount != null && (
                <div className="flex items-center justify-between rounded-lg bg-brand-light px-3 py-2">
                  <span className="text-sm text-brand-dark">Amount</span>
                  <span className="font-bold text-brand-dark">{formatMoney(d.amount, currency)}</span>
                </div>
              )}
            </Card>
          </section>
        )
      })}

      {isHq && (
        <button
          type="button"
          onClick={addEntry}
          className="mt-3 flex h-12 w-full items-center justify-center rounded-xl border border-dashed border-slate-300 text-sm font-medium text-slate-600 active:bg-slate-100"
        >
          + Add another work entry
        </button>
      )}

      {entries.length > 1 && anyAmount && (
        <div className="mt-3 flex items-center justify-between rounded-xl bg-brand-light px-3 py-2.5">
          <span className="text-sm text-brand-dark">Total · {entries.length} records</span>
          <span className="font-bold text-brand-dark">{formatMoney(total, currency)}</span>
        </div>
      )}

      {/* Optional photos — small compact 3-up box */}
      <Card className="mt-4 p-4">
        <p className="mb-1 text-sm font-medium text-slate-700">
          Photos<span className="text-slate-500"> (optional)</span>
        </p>
        <p className="mb-2 text-xs text-slate-500">
          A photo sets Start/End mode and fills the time + GPS.
          {entries.length > 1 && ' Photos are kept on Work details 1 only — the other entries are separate jobs.'}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <PhotoCapture compact label="Start meter" value={startPhoto} onChange={(p) => onPhoto('start', p)} />
          <PhotoCapture compact label="Start photo 2" value={workPhoto} onChange={(p) => onPhoto('work', p)} />
          <PhotoCapture compact label="Proof of work" value={endWorkPhoto} onChange={(p) => onPhoto('endwork', p)} />
          <PhotoCapture compact label="End meter" value={endPhoto} onChange={(p) => onPhoto('end', p)} />
        </div>
      </Card>

      {error && <p className="mt-3 text-sm text-red-500">{error}</p>}

      {incomplete.length > 0 && (
        <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
          <IconWarning width={16} height={16} className="mt-0.5 shrink-0" />
          <span>
            {entries.length > 1
              ? `Incomplete — Work details ${incomplete.join(', ')} still ${
                  incomplete.length === 1 ? 'needs' : 'need'
                } a duration or work type. You can still save.`
              : `Incomplete record — missing ${[
                  derived[0].durationMins == null ? 'duration' : null,
                  !derived[0].rate ? 'work type (piece rate)' : null
                ]
                  .filter(Boolean)
                  .join(' and ')}. You can still save.`}
          </span>
        </div>
      )}

      <Button full type="submit" className="mt-4" disabled={busy}>
        {busy ? 'Saving…' : entries.length > 1 ? `Add ${entries.length} records` : 'Add record'}
      </Button>
    </form>
  )
}
