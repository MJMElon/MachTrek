import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext.jsx'
import {
  getTask,
  getPhoto,
  completeTask,
  saveTaskProgress,
  deleteTask,
  listPieceRates,
  listAreas,
  listOperatorMachines,
  listCompanies,
  getOperator,
  kerjaJamRate,
  listTaskTracks
} from '../../db/repo.js'
import { isDistanceUnit, isDayUnit, DAY_QTY_CHOICES } from '../../lib/dashboard.js'

// Code-split: Leaflet only loads when an operator actually opens the map.
const DistanceRecorder = lazy(() => import('../../components/DistanceRecorder.jsx'))
import { TaskStatus, GpsSource } from '../../db/models.js'
import { minutesBetween, formatHours } from '../../lib/duration.js'
import { timeOf, dateTimeOf, formatMoney, formatRate, toLocalInput, fromLocalInput, formatLatLng, parseLatLng } from '../../lib/format.js'
import { QuantityInput } from '../../components/QuantityInput.jsx'
import { evalExpr, isExpression } from '../../lib/expr.js'
import { requestSync } from '../../sync/syncEngine.js'

const geoFor = (loc, fallback) => {
  const { lat, lng } = parseLatLng(loc)
  if (lat == null && lng == null) return fallback || undefined
  const changed = lat !== (fallback?.lat ?? null) || lng !== (fallback?.lng ?? null)
  return { lat, lng, source: changed ? GpsSource.MANUAL : fallback?.source || GpsSource.DEVICE, accuracy: fallback?.accuracy ?? null }
}
import { getMeta } from '../../db/database.js'
import PhotoCapture from '../../components/PhotoCapture.jsx'
import { Lightbox, PhotoById } from '../../components/PhotoThumb.jsx'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Card, Field, TextInput, TextArea, Select, Spinner } from '../../components/ui.jsx'

export default function CompleteTask() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const task = useLiveQuery(() => getTask(id), [id], undefined)
  const machines = useLiveQuery(() => listOperatorMachines(user.operatorId), [user.operatorId], [])
  const operator = useLiveQuery(() => getOperator(user.operatorId), [user.operatorId], null)
  const companies = useLiveQuery(() => listCompanies({ includeInactive: true }), [], [])
  const areas = useLiveQuery(() => listAreas({ companyId: user.companyId }), [user.companyId], [])
  const currency = useLiveQuery(() => getMeta('currency', 'RM'), [], 'RM')

  const [endWorkPhoto, setEndWorkPhoto] = useState(null)
  const [endPhoto, setEndPhoto] = useState(null)
  const [endTime, setEndTime] = useState('')
  const [timeTouched, setTimeTouched] = useState(false)
  const [endLoc, setEndLoc] = useState('')
  const [locTouched, setLocTouched] = useState(false)
  const [machineId, setMachineId] = useState('')
  const [rateId, setRateId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [areaId, setAreaId] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [mapOpen, setMapOpen] = useState(false)
  const [startPhotoZoom, setStartPhotoZoom] = useState(null)
  const submitting = useRef(false)
  const hydrated = useRef(false)
  const rateHydrated = useRef(false)
  const finalizing = useRef(false) // true once completing/deleting — stop auto-save
  const savedWork = useRef(null) // end-work photo object already persisted
  const savedMeter = useRef(null) // end-meter photo object already persisted
  const removedWork = useRef(false) // operator cleared the proof-of-work photo
  const removedMeter = useRef(false) // operator cleared the ending-meter photo

  // Photo handlers that also record an explicit "cleared" flag, so a removal is
  // persisted (and can't misfire during hydration, which sets the photo directly).
  const onEndWorkPhoto = (p) => {
    setEndWorkPhoto(p)
    removedWork.current = !p
  }
  const onEndPhoto = (p) => {
    setEndPhoto(p)
    removedMeter.current = !p
  }

  // Piece rates belong to the chosen machine.
  const rates = useLiveQuery(
    () => (machineId ? listPieceRates({ machineId }) : Promise.resolve([])),
    [machineId],
    []
  )

  // End time comes from the ending meter photo only (the true end-of-work
  // moment), not the proof-of-work photo.
  const suggested = endPhoto?.capturedAt || null
  useEffect(() => {
    if (!timeTouched && suggested) setEndTime(toLocalInput(suggested))
  }, [suggested, timeTouched])

  // Pre-fill the location from an end photo's GPS, until edited by hand.
  useEffect(() => {
    if (locTouched) return
    const g = (endPhoto?.gps?.lat != null && endPhoto.gps) || (endWorkPhoto?.gps?.lat != null && endWorkPhoto.gps) || null
    if (g) setEndLoc(formatLatLng(g.lat, g.lng))
  }, [endPhoto, endWorkPhoto, locTouched])

  // Resume a saved draft: fill the form (once) from whatever was saved on the
  // task. Photos re-hydrate from their stored rows on this device.
  useEffect(() => {
    if (hydrated.current || !task || task.status === TaskStatus.COMPLETED) return
    hydrated.current = true
    if (task.machineId) setMachineId(task.machineId)
    if (task.quantityExpr) setQuantity(task.quantityExpr)
    else if (task.quantity != null) setQuantity(String(task.quantity))
    if (task.areaId) setAreaId(task.areaId)
    if (task.notes) setNotes(task.notes)
    if (task.endTime) {
      setTimeTouched(true)
      setEndTime(toLocalInput(task.endTime))
    }
    if (task.endGps?.lat != null) {
      setLocTouched(true)
      setEndLoc(formatLatLng(task.endGps.lat, task.endGps.lng))
    }
    ;(async () => {
      if (task.endWorkPhotoId) {
        const p = await getPhoto(task.endWorkPhotoId)
        if (p) {
          const obj = { blob: p.blob || null, capturedAt: p.capturedAt, gps: p.gps, storagePath: p.storagePath }
          savedWork.current = obj // already persisted — don't re-upload on auto-save
          setEndWorkPhoto(obj)
        }
      }
      if (task.endPhotoId) {
        const p = await getPhoto(task.endPhotoId)
        if (p) {
          const obj = { blob: p.blob || null, capturedAt: p.capturedAt, gps: p.gps, storagePath: p.storagePath }
          savedMeter.current = obj
          setEndPhoto(obj)
        }
      }
    })()
  }, [task])

  const machine = useMemo(() => (machines || []).find((m) => m.id === machineId) || null, [machines, machineId])
  const company = useMemo(
    () => (companies || []).find((c) => c.id === machine?.companyId) || null,
    [companies, machine]
  )
  // "Kerja jam" (operator hourly rate) is offered alongside the machine's rates.
  const rateOptions = useMemo(
    () => (machineId ? [kerjaJamRate(operator), ...(rates || [])] : []),
    [machineId, operator, rates]
  )
  const rate = useMemo(() => rateOptions.find((r) => r.id === rateId) || null, [rateOptions, rateId])
  const area = useMemo(() => (areas || []).find((a) => a.id === areaId) || null, [areas, areaId])

  // The saved piece rate can only be re-selected once its options load (they
  // depend on the machine). Match by id, or by name for "Kerja jam".
  useEffect(() => {
    if (rateHydrated.current || !task || !rateOptions.length) return
    if (task.pieceRateId && rateOptions.some((r) => r.id === task.pieceRateId)) {
      rateHydrated.current = true
      setRateId(task.pieceRateId)
    } else if (task.pieceRateName) {
      const m = rateOptions.find((r) => r.name === task.pieceRateName)
      if (m) {
        rateHydrated.current = true
        setRateId(m.id)
      }
    }
  }, [task, rateOptions])

  // ---- GPS distance recording (meter-unit piece work only) ----------------
  // Section shows only when the chosen work is measured in meters. Once a
  // recording is saved for this task, the quantity is LOCKED to the measured
  // total (not hand-editable) — live query so a save in the map overlay lands
  // here immediately. Multiple recordings add up; tapping the locked quantity
  // expands the per-recording audit breakdown.
  const rateIsMeters = !!rate && isDistanceUnit(rate.unit)
  const taskTracks = useLiveQuery(() => listTaskTracks(id), [id], [])
  const trackTotal = useMemo(
    () => Math.round((taskTracks || []).reduce((s, t) => s + (Number(t.distanceMeters) || 0), 0) * 10) / 10,
    [taskTracks]
  )
  const qtyLocked = rateIsMeters && trackTotal > 0
  const [showQtyFormula, setShowQtyFormula] = useState(false)
  // The recordings as an Excel-style sum, e.g. "320+150" — shown on tap and
  // saved as the record's quantity formula for audit.
  const trackExpr = useMemo(
    () => (taskTracks || []).map((t) => Math.round((Number(t.distanceMeters) || 0) * 10) / 10).join('+'),
    [taskTracks]
  )
  const wasLocked = useRef(false)
  useEffect(() => {
    if (qtyLocked) {
      wasLocked.current = true
      setQuantity(String(trackTotal))
    } else if (wasLocked.current) {
      // Switched away from distance work — don't carry the metres across into
      // a quantity that now means hours or days.
      wasLocked.current = false
      setQuantity('')
    }
  }, [qtyLocked, trackTotal])

  const endISO = fromLocalInput(endTime)
  const durationMins = task ? minutesBetween(task.startTime, endISO) : null
  const qtyNum = evalExpr(quantity)
  const amount = rate && qtyNum != null ? qtyNum * Number(rate.price) : null

  // ---- Auto-save the draft (offline-first) --------------------------------
  // Every change is written to local IndexedDB so a half-finished task is never
  // lost, even with no connection. After each save we request a sync, which
  // pushes to the server when online and simply stays queued when offline.
  const draft = {
    endTime: endTime ? endISO : null,
    // Only pass photos that carry new bytes; already-saved ones keep their ids.
    endWorkPhoto: endWorkPhoto?.blob && endWorkPhoto !== savedWork.current ? endWorkPhoto : null,
    endPhoto: endPhoto?.blob && endPhoto !== savedMeter.current ? endPhoto : null,
    removeEndWorkPhoto: removedWork.current,
    removeEndPhoto: removedMeter.current,
    endGps: geoFor(endLoc, endPhoto?.gps || endWorkPhoto?.gps),
    machine,
    company,
    pieceRate: rate,
    quantity: qtyNum,
    // GPS-locked quantity keeps its per-recording sum (e.g. "320+150") as the
    // formula for audit — same as a manually typed sum would.
    quantityExpr: qtyLocked
      ? (taskTracks || []).length > 1
        ? trackExpr
        : null
      : isExpression(quantity)
        ? quantity.trim()
        : null,
    area,
    notes
  }
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saveDraftRef = useRef(null)
  saveDraftRef.current = async () => {
    if (finalizing.current || !hydrated.current) return
    const d = draftRef.current
    try {
      // Write to the local IndexedDB first — this always succeeds offline. Only
      // after it's safely stored do we ask the sync engine to push it.
      await saveTaskProgress(id, d)
      if (d.endWorkPhoto) savedWork.current = d.endWorkPhoto
      if (d.endPhoto) savedMeter.current = d.endPhoto
      if (d.removeEndWorkPhoto) removedWork.current = false
      if (d.removeEndPhoto) removedMeter.current = false
      requestSync() // push now if online; stays queued locally when offline
    } catch {
      /* offline or month locked — the next change will retry */
    }
  }

  // Debounced auto-save on any change to the finish form (photo, machine, rate…).
  // Short delay so a filled field is persisted locally almost immediately.
  useEffect(() => {
    if (!hydrated.current) return
    const timer = setTimeout(() => saveDraftRef.current?.(), 250)
    return () => clearTimeout(timer)
  }, [endTime, endLoc, endWorkPhoto, endPhoto, machineId, rateId, quantity, areaId, notes])

  // Also flush the moment the page is hidden or closed — mobile browsers freeze
  // or kill a backgrounded PWA before an unmount would run, which is exactly when
  // an offline draft would otherwise be lost. All writes are local, so no
  // connection is needed here.
  useEffect(() => {
    const flush = () => saveDraftRef.current?.()
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    document.addEventListener('visibilitychange', onHide)
    window.addEventListener('pagehide', flush)
    // And once more on the way out (in-app back navigation).
    return () => {
      document.removeEventListener('visibilitychange', onHide)
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  if (task === undefined) {
    return (
      <div className="flex justify-center py-20 text-brand">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (!task || task.status === TaskStatus.COMPLETED) {
    return (
      <div className="py-10 text-center text-slate-500">
        <p>Kerja ini sudah ditutup.</p>
        <Button className="mt-4" onClick={() => navigate('/open')}>
          Kembali
        </Button>
      </div>
    )
  }

  // Area is only required when the admin has set up areas for this company;
  // otherwise it's optional. Piece rate + quantity are always optional.
  const areaRequired = (areas || []).length > 0
  const canSave = endWorkPhoto && endPhoto && endTime && machineId && (!areaRequired || areaId)

  async function submit(e) {
    e.preventDefault()
    if (submitting.current) return
    setError('')
    if (!canSave) {
      setError(
        areaRequired
          ? 'Lengkapkan gambar, masa tamat, mesin dan kawasan.'
          : 'Lengkapkan gambar, masa tamat dan mesin.'
      )
      return
    }
    if (durationMins == null) {
      setError('Masa tamat lebih awal daripada masa mula.')
      return
    }
    if (quantity.trim() !== '' && qtyNum == null) {
      setError('Kuantiti mesti nombor atau jumlah seperti 5+5+10-6.')
      return
    }
    submitting.current = true
    finalizing.current = true // stop auto-save from racing the completion
    setBusy(true)
    try {
      await completeTask(id, {
        endTime: endISO,
        endWorkPhoto,
        endPhoto,
        endGps: geoFor(endLoc, endPhoto?.gps || endWorkPhoto?.gps),
        machine,
        company,
        pieceRate: rate,
        quantity: qtyNum,
        quantityExpr: qtyLocked
          ? (taskTracks || []).length > 1
            ? trackExpr
            : null
          : isExpression(quantity)
            ? quantity.trim()
            : null,
        area,
        notes
      })
      navigate('/summary')
    } catch (err) {
      setError('Gagal simpan. Cuba lagi.')
      setBusy(false)
      submitting.current = false
      finalizing.current = false // completion failed — let auto-save resume
    }
  }

  // Operators can discard a hanging task they no longer need to finish.
  async function remove() {
    if (busy) return
    if (!window.confirm('Padam kerja ini? Tindakan ini kekal.')) return
    finalizing.current = true // stop auto-save from re-creating what we delete
    setError('')
    setBusy(true)
    try {
      await deleteTask(id)
      navigate('/open')
    } catch (err) {
      setError('Gagal padam. Cuba lagi.')
      setBusy(false)
      finalizing.current = false
    }
  }

  // Leaving via the back button: persist the draft to local IndexedDB FIRST,
  // then navigate — so a quick back can never lose the changes.
  async function goBack() {
    await saveDraftRef.current?.()
    navigate('/open')
  }

  return (
    <form onSubmit={submit} className="pb-4">
      <PageHeader
        title="Siapkan kerja"
        subtitle={`Mula ${dateTimeOf(task.startTime, 'ms-MY')}`}
        onBack={goBack}
        language="ms"
      />

      {/* Reference: the start photos — small thumbnails, this is just context */}
      <Card className="mb-3 p-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Mula kerja</p>
          <p className="text-[11px] text-slate-500">Tekan gambar</p>
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <PhotoById id={task.startPhotoId} className="h-20 w-full" onZoom={setStartPhotoZoom} language="ms" />
            <p className="mt-0.5 text-center text-[11px] text-slate-500">Meter · {timeOf(task.startTime)}</p>
          </div>
          {task.workPhotoId && (
            <div className="flex-1">
              <PhotoById id={task.workPhotoId} className="h-20 w-full" onZoom={setStartPhotoZoom} language="ms" />
              <p className="mt-0.5 text-center text-[11px] text-slate-500">Gambar 2</p>
            </div>
          )}
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="space-y-4 p-4">
          <Field label="Mesin" required>
            <Select
              value={machineId}
              onChange={(e) => {
                setMachineId(e.target.value)
                setRateId('') // rates depend on the machine
              }}
            >
              <option value="">Pilih mesin…</option>
              {(machines || []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            {machines && machines.length === 0 && (
              <p className="mt-1 text-xs text-red-500">Tiada mesin. Hubungi admin.</p>
            )}
          </Field>

          <Field label="Jenis kerja" hint={machineId ? 'Pilihan' : 'Pilih mesin dahulu'}>
            <Select value={rateId} onChange={(e) => setRateId(e.target.value)} disabled={!machineId}>
              <option value="">{machineId ? 'Pilih jenis kerja…' : 'Pilih mesin dahulu'}</option>
              {rateOptions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} — {formatRate(r.price, currency)}/{r.unit}
                </option>
              ))}
            </Select>
            {machineId && rates && rates.length === 0 && (
              <p className="mt-1 text-xs text-red-500">Tiada kadar. Hubungi admin.</p>
            )}
          </Field>

          {/* GPS distance recorder — distance work only. Paths left over from a
              switched-away job are cleaned up on completion, so there's nothing
              to reach here. */}
          {rateIsMeters && (
            <button
              type="button"
              onClick={() => {
                // Request location INSIDE the tap gesture — browsers show the
                // full permission dialog most reliably from a user action
                // (outside a gesture Chrome may use its quiet, easy-to-miss UI).
                navigator.geolocation?.getCurrentPosition(
                  () => {},
                  () => {},
                  { maximumAge: Infinity, timeout: 5000 }
                )
                setMapOpen(true)
              }}
              className="flex w-full items-center justify-between rounded-xl border border-brand/40 bg-brand-light/50 px-3 py-3 text-left active:bg-brand-light"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-brand-dark">Rekod jarak (GPS)</p>
                <p className="text-xs text-slate-600">
                  {trackTotal > 0
                    ? `Direkod: ${trackTotal.toLocaleString()} m`
                    : 'Pilihan · guna peta satelit'}
                </p>
              </div>
              <span className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white">Buka</span>
            </button>
          )}

          <Field
            label={`Kuantiti${rate ? ` (${rate.unit})` : ''}`}
            hint={
              qtyLocked
                ? 'Daripada peta · tekan untuk jumlah'
                : rate && isDayUnit(rate.unit)
                  ? 'Setengah hari atau satu hari'
                  : 'Pilihan · contoh 5+5+10'
            }
          >
            {rate && isDayUnit(rate.unit) && !qtyLocked ? (
              // Kerja harian hanya 1/2 hari atau 1 hari — pilih, bukan taip.
              <Select value={quantity} onChange={(e) => setQuantity(e.target.value)}>
                <option value="">Pilih…</option>
                {DAY_QTY_CHOICES.map((v) => (
                  <option key={v} value={v}>
                    {v} hari
                  </option>
                ))}
              </Select>
            ) : qtyLocked ? (
              // Excel-cell behaviour, read-only: shows the total; tap to reveal
              // the sum formula (e.g. "320+150"); tap again for the total.
              <button
                type="button"
                onClick={() => setShowQtyFormula((v) => !v)}
                className="flex h-12 w-full items-center rounded-xl border border-slate-300 bg-slate-100 px-3.5 text-left font-semibold text-slate-800"
              >
                {showQtyFormula ? trackExpr : `${trackTotal.toLocaleString()} m`}
              </button>
            ) : (
              <QuantityInput value={quantity} onChange={setQuantity} placeholder="cth. 3 atau 5+5+10" />
            )}
          </Field>

          <Field label="Kawasan" required={areaRequired} hint={areaRequired ? undefined : 'Pilihan'}>
            <Select value={areaId} onChange={(e) => setAreaId(e.target.value)}>
              <option value="">{areaRequired ? 'Pilih kawasan…' : 'Tiada kawasan'}</option>
              {(areas || []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Catatan">
            <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </Card>

        {amount != null && (
          <Card className="flex items-center justify-between bg-brand-light p-4">
            <span className="text-sm text-brand-dark">Jumlah</span>
            <span className="text-xl font-bold text-brand-dark">{formatMoney(amount, currency)}</span>
          </Card>
        )}

        {/* End-of-task evidence — kept last, right before Complete */}
        <PhotoCapture
          language="ms"
          label="Bukti kerja"
          required
          value={endWorkPhoto}
          onChange={onEndWorkPhoto}
          detectTime={false}
          previewHeight="h-28"
        />
        <PhotoCapture
          language="ms"
          label="Gambar meter akhir"
          required
          value={endPhoto}
          onChange={onEndPhoto}
          previewHeight="h-28"
        />

        <Card className="space-y-4 p-4">
          <Field label="Masa tamat" required>
            <TextInput
              type="datetime-local"
              step="1"
              value={endTime}
              onChange={(e) => {
                setTimeTouched(true)
                setEndTime(e.target.value)
              }}
            />
          </Field>
          <Field label="Lokasi tamat">
            <TextInput
              value={endLoc}
              onChange={(e) => {
                setLocTouched(true)
                setEndLoc(e.target.value)
              }}
              placeholder="cth. 3.13921, 101.6869"
            />
          </Field>
          <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
            <span className="text-sm text-slate-500">Tempoh</span>
            <span className="text-lg font-bold text-slate-800">
              {formatHours(durationMins)}
            </span>
          </div>
        </Card>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <Button full type="submit" disabled={busy || !canSave}>
          {busy ? 'Menyimpan…' : 'Siap kerja'}
        </Button>

        <p className="text-center text-xs text-slate-500">
          Disimpan automatik.
        </p>

        <Button full type="button" variant="danger" disabled={busy} onClick={remove}>
          Padam kerja
        </Button>
      </div>

      {/* Full-screen satellite map recorder (loads Leaflet on demand) */}
      {mapOpen && (
        <Suspense fallback={<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 text-white"><Spinner className="h-8 w-8" /></div>}>
          <DistanceRecorder
            open={mapOpen}
            onClose={() => setMapOpen(false)}
            session={user}
            taskId={id}
            pieceRate={rate}
            boundary={company?.boundary || null}
            // The operator may remove a path from THIS job only (it's still
            // unfinished); earlier jobs' paths stay untouchable.
            canDelete
            deletableTaskId={id}
            deleteLabel="Padam"
            deleteConfirm="Padam rekod jarak {d} ini? Kuantiti akan dikemas kini."
            onSaved={() => {}}
            language="ms"
          />
        </Suspense>
      )}

      <Lightbox url={startPhotoZoom} onClose={() => setStartPhotoZoom(null)} language="ms" />
    </form>
  )
}
