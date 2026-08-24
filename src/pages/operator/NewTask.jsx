import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.jsx'
import { startTask } from '../../db/repo.js'
import { GpsSource } from '../../db/models.js'
import { toLocalInput, fromLocalInput, formatLatLng, parseLatLng } from '../../lib/format.js'

const geoFor = (loc, fallback) => {
  const { lat, lng } = parseLatLng(loc)
  if (lat == null && lng == null) return fallback || undefined
  const changed = lat !== (fallback?.lat ?? null) || lng !== (fallback?.lng ?? null)
  return { lat, lng, source: changed ? GpsSource.MANUAL : fallback?.source || GpsSource.DEVICE, accuracy: fallback?.accuracy ?? null }
}
import PhotoCapture from '../../components/PhotoCapture.jsx'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Card, Field, TextInput, TextArea } from '../../components/ui.jsx'
import { IconPlus } from '../../components/icons.jsx'

export default function NewTask() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [photo1, setPhoto1] = useState(null)
  const [photo2, setPhoto2] = useState(null)
  // Photo 2 is optional and rarely used — keep the form short by hiding it
  // behind a thin button until the operator asks for it.
  const [showPhoto2, setShowPhoto2] = useState(false)
  const [startTime, setStartTime] = useState('')
  const [timeTouched, setTimeTouched] = useState(false)
  const [startLoc, setStartLoc] = useState('')
  const [locTouched, setLocTouched] = useState(false)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false) // synchronous double-submit guard

  // Start time + location come from the meter photo (photo 1) only — photo 2 is
  // an optional extra and shouldn't drive them.
  const suggested = photo1?.capturedAt || null
  useEffect(() => {
    if (!timeTouched && suggested) setStartTime(toLocalInput(suggested))
  }, [suggested, timeTouched])

  useEffect(() => {
    if (locTouched) return
    if (photo1?.gps?.lat != null) setStartLoc(formatLatLng(photo1.gps.lat, photo1.gps.lng))
  }, [photo1, locTouched])

  const canSave = photo1 && startTime

  async function submit(e) {
    e.preventDefault()
    if (submitting.current) return
    setError('')
    if (!canSave) {
      setError('Tambah gambar meter dan masa mula.')
      return
    }
    submitting.current = true
    setBusy(true)
    try {
      await startTask({
        session: user, // carries companyId/companyName/machineId/machineName/operatorName
        startTime: fromLocalInput(startTime),
        startGps: geoFor(startLoc, photo1?.gps),
        notes,
        startPhoto: photo1,
        workPhoto: photo2
      })
      navigate('/open')
    } catch (err) {
      setError('Gagal simpan. Cuba lagi.')
      setBusy(false)
      submitting.current = false
    }
  }

  return (
    <form onSubmit={submit} className="pb-4">
      <PageHeader
        title="Mula kerja"
        subtitle="Ambil gambar meter."
        onBack={() => navigate('/open')}
        language="ms"
      />

      <div className="space-y-4">
        <PhotoCapture
          language="ms"
          label="Gambar meter"
          captureLabel="Ambil gambar meter mula"
          required
          value={photo1}
          onChange={setPhoto1}
        />
        {showPhoto2 || photo2 ? (
          <PhotoCapture
            language="ms"
            label="Gambar tambahan"
            value={photo2}
            onChange={(p) => {
              setPhoto2(p)
              if (!p) setShowPhoto2(false) // removed → collapse back to the button
            }}
            detectTime={false}
            detectLocation={false}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowPhoto2(true)}
            className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-white py-2.5 text-sm font-medium text-slate-600 active:bg-slate-50"
          >
            <IconPlus width={16} height={16} /> Tambah gambar
          </button>
        )}

        <Card className="space-y-3 p-4">
          <Field label="Masa mula" required>
            <TextInput
              type="datetime-local"
              step="1"
              value={startTime}
              onChange={(e) => {
                setTimeTouched(true)
                setStartTime(e.target.value)
              }}
            />
          </Field>
          <Field label="Lokasi mula">
            <TextInput
              value={startLoc}
              onChange={(e) => {
                setLocTouched(true)
                setStartLoc(e.target.value)
              }}
              placeholder="cth. 3.13921, 101.6869"
            />
          </Field>
          <Field label="Catatan">
            <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </Card>

        {error && <p className="text-sm text-red-500">{error}</p>}

        <Button full type="submit" disabled={busy || !canSave}>
          {busy ? 'Menyimpan…' : 'Simpan'}
        </Button>
      </div>
    </form>
  )
}
