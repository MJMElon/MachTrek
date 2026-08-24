import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.jsx'
import { startTask } from '../../db/repo.js'
import PhotoCapture from '../../components/PhotoCapture.jsx'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Card, Field, TextArea } from '../../components/ui.jsx'
import { IconPlus } from '../../components/icons.jsx'

export default function NewTask() {
  const { user } = useAuth()
  const navigate = useNavigate()

  const [photo1, setPhoto1] = useState(null)
  const [photo2, setPhoto2] = useState(null)
  // Photo 2 is optional and rarely used — keep the form short by hiding it
  // behind a thin button until the operator asks for it.
  const [showPhoto2, setShowPhoto2] = useState(false)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false) // synchronous double-submit guard

  // Start time + location come from the meter photo (photo 1) only — photo 2 is
  // an optional extra and shouldn't drive them. The operator can correct both
  // right under the photo (PhotoCapture `editable`), so there are no separate
  // time/location form fields here.
  const canSave = photo1?.capturedAt

  async function submit(e) {
    e.preventDefault()
    if (submitting.current) return
    setError('')
    if (!canSave) {
      setError('Tambah gambar meter.')
      return
    }
    submitting.current = true
    setBusy(true)
    try {
      await startTask({
        session: user, // carries companyId/companyName/machineId/machineName/operatorName
        startTime: photo1.capturedAt,
        startGps: photo1.gps,
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
          cameraOnly
          editable
          value={photo1}
          onChange={setPhoto1}
        />
        {showPhoto2 || photo2 ? (
          <PhotoCapture
            language="ms"
            label="Gambar tambahan"
            cameraOnly
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

        <Card className="p-4">
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
