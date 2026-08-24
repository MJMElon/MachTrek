import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getPhoto } from '../db/repo.js'
import { capturePhotoMeta, getDevicePosition } from '../lib/photoMeta.js'
import { compressImage, stampPhoto } from '../lib/image.js'
import { GpsSource } from '../db/models.js'
import { dateTimeSecondsOf, formatGps, formatBytes, toLocalInput, fromLocalInput, formatLatLng, parseLatLng } from '../lib/format.js'
import { usePhotoUrl, Lightbox } from './PhotoThumb.jsx'
import { IconCamera, IconPin, IconClock } from './icons.jsx'
import { Spinner } from './ui.jsx'

/**
 * Capture one photo. A single "Take photo" button opens the device's native
 * chooser, which offers BOTH the camera and uploading from phone storage —
 * unless `cameraOnly` is set (operator flows), which forces the live camera so
 * photos are taken on the spot, not picked from the gallery.
 * The photo's timestamp (to the second) + GPS are read from its EXIF, falling
 * back to the live device GPS/clock only when the file has none.
 *
 * value:    { blob, capturedAt, gps, timeSource } | null
 * onChange: (captured | null) => void
 */
export default function PhotoCapture({
  label,
  hint,
  value,
  onChange,
  required,
  compact,
  detectTime = true,
  detectLocation = true,
  // Admin edit: show the photo already saved on the record (by id) in the tile,
  // and confirm before it gets replaced.
  existingId = null,
  confirmReplace = false,
  previewHeight = 'h-44', // shorter previews keep long forms scrollable
  language = 'en',
  captureLabel = null,
  cameraOnly = false, // operator flows: force the live camera, no gallery picking
  editable = false // operator flows: tap the time/location rows to correct them
}) {
  const ms = language === 'ms'
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [zoom, setZoom] = useState(null)
  const [editTime, setEditTime] = useState(false)
  const [editLoc, setEditLoc] = useState(false)
  const [locText, setLocText] = useState('') // free text while typing "lat, lng"
  // Fall back to the record's saved photo until a new one is picked.
  const saved = useLiveQuery(
    () => (existingId && !value ? getPhoto(existingId) : Promise.resolve(null)),
    [existingId, value],
    null
  )
  const shown = value || saved
  const previewUrl = usePhotoUrl(shown)

  // Ask before overwriting a photo that is already on the record.
  const pickFile = () => {
    if (confirmReplace && !value && saved && !window.confirm(ms ? 'Ganti gambar ini?' : 'Replace this photo?')) return
    inputRef.current?.click()
  }
  const tokenRef = useRef(0) // invalidates a stale in-flight detection
  const warmGpsRef = useRef(null) // device fix warmed up when the form opened
  // The background EXIF pass must never clobber a value the operator has
  // already corrected by hand — track manual edits per field.
  const valueRef = useRef(null)
  valueRef.current = value
  const manualRef = useRef({ time: false, gps: false })

  // Warm up the device location as soon as the form opens, so a fix is ready by
  // capture time (and the permission prompt appears up front). Only for the full
  // operator photos — not the admin compact tiles.
  useEffect(() => {
    if (compact || !detectLocation) return
    let alive = true
    getDevicePosition().then((pos) => {
      if (alive && pos) warmGpsRef.current = pos
    })
    return () => {
      alive = false
    }
  }, [compact, detectLocation])

  // Invalidate any pending detection and clear the photo.
  function clear() {
    tokenRef.current++
    setDetecting(false)
    onChange(null)
  }

  async function handleFile(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file
    if (!file) return
    const token = ++tokenRef.current
    setEditTime(false) // a fresh photo starts from its own detected metadata
    setEditLoc(false)
    manualRef.current = { time: false, gps: false }
    setBusy(true)
    try {
      // Show the photo immediately with provisional metadata (current time + the
      // warmed-up GPS), so no one is blocked by slower EXIF/GPS reads. Detection
      // then refines it in the background. Same fast path for operator and admin.
      const blob = await compressImage(file)
      if (token !== tokenRef.current) return
      const warm = detectLocation ? warmGpsRef.current : null
      const provisionalAt = new Date().toISOString()
      const provisionalGps = warm
        ? { lat: warm.lat, lng: warm.lng, source: GpsSource.DEVICE, accuracy: warm.accuracy ?? null }
        : { lat: null, lng: null, source: GpsSource.NONE, accuracy: null }
      const provisional = {
        // Operator evidence carries a burnt-in banner (date-time + GPS). The
        // provisional stamp is replaced below once EXIF/GPS detection lands —
        // always stamped onto the ORIGINAL blob, so banners never stack.
        blob: cameraOnly ? await stampPhoto(blob, { capturedAt: provisionalAt, gps: provisionalGps }) : blob,
        capturedAt: provisionalAt,
        timeSource: detectTime ? GpsSource.DEVICE : GpsSource.NONE,
        gps: provisionalGps
      }
      if (token !== tokenRef.current) return
      onChange(provisional)
      setBusy(false)

      // Refine time/location from EXIF (and a fresh GPS fix) in the background.
      if (detectTime || detectLocation) {
        setDetecting(true)
        capturePhotoMeta(file, { time: detectTime, gps: detectLocation })
          .then(async (meta) => {
            if (token !== tokenRef.current) return // photo replaced/removed meanwhile
            // Merge onto whatever the operator may have edited meanwhile;
            // hand-corrected fields win over the detected ones.
            const cur = valueRef.current || provisional
            const capturedAt = !manualRef.current.time && detectTime ? meta.capturedAt : cur.capturedAt
            const timeSource = !manualRef.current.time && detectTime ? meta.timeSource : cur.timeSource
            // Keep the warmed GPS if the background pass found nothing better.
            const gps = !manualRef.current.gps && meta.gps && meta.gps.lat != null ? meta.gps : cur.gps
            const finalBlob = cameraOnly ? await stampPhoto(blob, { capturedAt, gps }) : blob
            if (token !== tokenRef.current) return
            onChange({ ...cur, blob: finalBlob, capturedAt, timeSource, gps })
          })
          .finally(() => {
            if (token === tokenRef.current) setDetecting(false)
          })
      }
    } catch (err) {
      console.error('Photo capture failed', err)
      alert(ms ? 'Gambar gagal dibaca. Cuba lagi.' : 'Could not read that photo. Please try again.')
      if (token === tokenRef.current) setBusy(false)
    }
  }

  const gpsOk = value?.gps && value.gps.lat != null
  const sourceLabel =
    value?.gps?.source === GpsSource.EXIF
      ? ms ? 'daripada gambar' : 'from photo'
      : value?.gps?.source === GpsSource.DEVICE
        ? ms ? 'daripada telefon' : 'from device'
        : value?.gps?.source === GpsSource.MANUAL
          ? ms ? 'diubah' : 'edited'
          : null

  // Operator corrections, written straight onto the captured value.
  function setManualTime(localValue) {
    const iso = fromLocalInput(localValue)
    if (!iso || !value) return
    manualRef.current.time = true
    onChange({ ...value, capturedAt: iso, timeSource: GpsSource.MANUAL })
  }
  function setManualLoc(text) {
    setLocText(text)
    const { lat, lng } = parseLatLng(text)
    if (lat == null || lng == null || !value) return // keep typing — commit once valid
    manualRef.current.gps = true
    onChange({ ...value, gps: { lat, lng, source: GpsSource.MANUAL, accuracy: null } })
  }

  // Compact square tile — used for the optional 3-up photo box on the admin forms.
  if (compact) {
    return (
      <div>
        <input ref={inputRef} type="file" accept="image/*" hidden onChange={handleFile} />
        {!shown ? (
          <button
            type="button"
            onClick={pickFile}
            className="flex aspect-square w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 bg-white text-slate-500 active:bg-slate-50"
          >
            {busy ? <Spinner /> : <IconCamera width={20} height={20} />}
            {label && <span className="text-[11px] font-medium">{label}</span>}
          </button>
        ) : (
          <div className="relative aspect-square overflow-hidden rounded-xl border border-slate-200">
            <img
              src={previewUrl || ''}
              alt=""
              onClick={() => previewUrl && setZoom(previewUrl)}
              className="h-full w-full object-cover"
            />
            {/* Only a freshly picked photo can be cleared; a saved one is
                replaced instead (tap the caption), never silently dropped. */}
            {value && (
              <button
                type="button"
                onClick={clear}
                className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-sm leading-none text-white"
                aria-label={ms ? 'Buang gambar' : 'Remove photo'}
              >
                ×
              </button>
            )}
            <button
              type="button"
              onClick={pickFile}
              className="absolute inset-x-0 bottom-0 bg-black/50 py-0.5 text-center text-[10px] text-white"
            >
              {label || (ms ? 'Tukar' : 'Change')}
            </button>
          </div>
        )}
        <Lightbox url={zoom} onClose={() => setZoom(null)} language={language} />
      </div>
    )
  }

  return (
    <div>
      {label && (
        <p className="mb-1.5 text-sm font-medium text-slate-700">
          {label} {required && <span className="text-red-500">*</span>}
        </p>
      )}

      {/* `capture` forces the live camera; without it the native sheet offers
          Camera + Photo Library + Files. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        {...(cameraOnly ? { capture: 'environment' } : {})}
        hidden
        onChange={handleFile}
      />

      {!value ? (
        <div className="rounded-2xl border-2 border-dashed border-slate-300 bg-white p-4">
          {busy ? (
            <div className="flex flex-col items-center gap-2 py-6 text-slate-500">
              <Spinner />
              <span className="text-sm">{ms ? 'Membaca gambar…' : 'Reading photo & location…'}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex w-full flex-col items-center gap-1 rounded-xl bg-brand py-5 text-white active:bg-brand-dark"
            >
              <IconCamera width={28} height={28} />
              <span className="text-base font-medium">{captureLabel || (ms ? 'Ambil gambar' : 'Take photo')}</span>
              <span className="text-[11px] text-white/80">
                {cameraOnly
                  ? ms ? 'Kamera sahaja' : 'Camera only'
                  : ms ? 'Kamera atau galeri' : 'Camera or upload from phone'}
              </span>
            </button>
          )}
          {hint && <p className="mt-2 text-center text-xs text-slate-500">{hint}</p>}
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="relative">
            <img
              src={previewUrl || ''}
              alt=""
              onClick={() => previewUrl && setZoom(previewUrl)}
              className={`${previewHeight} w-full object-cover`}
            />
            {busy && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-white">
                <Spinner />
              </div>
            )}
          </div>
          {/* Compact metadata strip. With `editable`, tapping a row opens an
              inline editor — no separate form fields needed. */}
          <div className="space-y-0.5 px-2.5 py-2 text-xs">
            {detectTime && (
              <>
                <button
                  type="button"
                  disabled={!editable}
                  onClick={() => setEditTime((v) => !v)}
                  className="flex w-full items-center gap-1.5 text-left text-slate-600 disabled:pointer-events-none"
                >
                  <IconClock width={13} height={13} className="shrink-0 text-slate-500" />
                  <span className="truncate">{dateTimeSecondsOf(value.capturedAt, ms ? 'ms-MY' : undefined)}</span>
                  {value.timeSource === GpsSource.DEVICE && (
                    <span className="shrink-0 text-[10px] text-amber-600">({ms ? 'masa telefon' : 'device time'})</span>
                  )}
                  {value.timeSource === GpsSource.MANUAL && (
                    <span className="shrink-0 text-[10px] text-slate-500">({ms ? 'diubah' : 'edited'})</span>
                  )}
                  {editable && <span className="ml-auto shrink-0 font-medium text-brand">{ms ? 'Ubah' : 'Edit'}</span>}
                </button>
                {editable && editTime && (
                  <input
                    type="datetime-local"
                    step="1"
                    autoFocus
                    value={toLocalInput(value.capturedAt)}
                    onChange={(e) => setManualTime(e.target.value)}
                    className="h-10 w-full rounded-lg border border-slate-300 px-2 text-sm"
                  />
                )}
              </>
            )}
            {detectLocation && (
              <>
                <button
                  type="button"
                  disabled={!editable}
                  onClick={() => {
                    setLocText(gpsOk ? formatLatLng(value.gps.lat, value.gps.lng) : '')
                    setEditLoc((v) => !v)
                  }}
                  className="flex w-full items-center gap-1.5 text-left text-slate-600 disabled:pointer-events-none"
                >
                  <IconPin width={13} height={13} className={`shrink-0 ${gpsOk ? 'text-slate-500' : 'text-red-400'}`} />
                  <span className={`truncate ${gpsOk ? '' : 'text-red-500'}`}>
                    {gpsOk ? formatGps(value.gps) : ms ? 'Tiada lokasi' : formatGps(value.gps)}
                  </span>
                  {sourceLabel && <span className="shrink-0 text-[10px] text-slate-500">({sourceLabel})</span>}
                  {editable && <span className="ml-auto shrink-0 font-medium text-brand">{ms ? 'Ubah' : 'Edit'}</span>}
                </button>
                {editable && editLoc && (
                  <input
                    type="text"
                    autoFocus
                    inputMode="decimal"
                    value={locText}
                    onChange={(e) => setManualLoc(e.target.value)}
                    placeholder={ms ? 'cth. 3.13921, 101.6869' : 'e.g. 3.13921, 101.6869'}
                    className="h-10 w-full rounded-lg border border-slate-300 px-2 text-sm"
                  />
                )}
                {!gpsOk && !editLoc && (
                  <p className="text-[10px] text-red-500">
                    {ms ? 'Lokasi tiada. Benarkan akses lokasi.' : 'No location found. Allow location access, or upload a photo that has GPS.'}
                  </p>
                )}
              </>
            )}
            {detecting && (
              <p className="text-[10px] text-slate-500">{ms ? 'Membaca tarikh dan lokasi…' : 'Reading date & location…'}</p>
            )}
            {value.blob?.size != null && (
              <p className="text-[10px] text-slate-500">{ms ? 'Saiz' : 'Upload size'} ≈ {formatBytes(value.blob.size)}</p>
            )}
          </div>
          <div className="flex border-t border-slate-100">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex-1 py-2.5 text-sm font-medium text-brand active:bg-brand-light"
            >
              {ms ? 'Tukar gambar' : 'Change photo'}
            </button>
            <div className="w-px bg-slate-100" />
            <button
              type="button"
              onClick={clear}
              className="flex-1 py-2.5 text-sm font-medium text-red-500 active:bg-red-50"
            >
              {ms ? 'Buang' : 'Remove'}
            </button>
          </div>
        </div>
      )}

      <Lightbox url={zoom} onClose={() => setZoom(null)} language={language} />
    </div>
  )
}
