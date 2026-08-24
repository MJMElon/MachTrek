import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getPhoto } from '../db/repo.js'
import { capturePhotoMeta, getDevicePosition } from '../lib/photoMeta.js'
import { compressImage } from '../lib/image.js'
import { GpsSource } from '../db/models.js'
import { dateTimeSecondsOf, formatGps, formatBytes } from '../lib/format.js'
import { usePhotoUrl, Lightbox } from './PhotoThumb.jsx'
import { IconCamera, IconPin, IconClock } from './icons.jsx'
import { Spinner } from './ui.jsx'

/**
 * Capture one photo. A single "Take photo" button opens the device's native
 * chooser, which offers BOTH the camera and uploading from phone storage
 * (we deliberately omit the `capture` attribute so the user can pick either).
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
  captureLabel = null
}) {
  const ms = language === 'ms'
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [zoom, setZoom] = useState(null)
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
    setBusy(true)
    try {
      // Show the photo immediately with provisional metadata (current time + the
      // warmed-up GPS), so no one is blocked by slower EXIF/GPS reads. Detection
      // then refines it in the background. Same fast path for operator and admin.
      const blob = await compressImage(file)
      if (token !== tokenRef.current) return
      const warm = detectLocation ? warmGpsRef.current : null
      const provisional = {
        blob,
        capturedAt: new Date().toISOString(),
        timeSource: detectTime ? GpsSource.DEVICE : GpsSource.NONE,
        gps: warm
          ? { lat: warm.lat, lng: warm.lng, source: GpsSource.DEVICE, accuracy: warm.accuracy ?? null }
          : { lat: null, lng: null, source: GpsSource.NONE, accuracy: null }
      }
      onChange(provisional)
      setBusy(false)

      // Refine time/location from EXIF (and a fresh GPS fix) in the background.
      if (detectTime || detectLocation) {
        setDetecting(true)
        capturePhotoMeta(file, { time: detectTime, gps: detectLocation })
          .then((meta) => {
            if (token !== tokenRef.current) return // photo replaced/removed meanwhile
            onChange({
              blob,
              capturedAt: detectTime ? meta.capturedAt : provisional.capturedAt,
              timeSource: detectTime ? meta.timeSource : provisional.timeSource,
              // Keep the warmed GPS if the background pass found nothing better.
              gps: meta.gps && meta.gps.lat != null ? meta.gps : provisional.gps
            })
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
        : null

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

      {/* No `capture` attr => native sheet offers Camera + Photo Library + Files */}
      <input ref={inputRef} type="file" accept="image/*" hidden onChange={handleFile} />

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
              <span className="text-[11px] text-white/80">{ms ? 'Kamera atau galeri' : 'Camera or upload from phone'}</span>
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
          <div className="space-y-1 p-3 text-sm">
            {detectTime && (
              <div className="flex items-center gap-2 text-slate-600">
                <IconClock width={15} height={15} className="text-slate-500" />
                <span>{dateTimeSecondsOf(value.capturedAt, ms ? 'ms-MY' : undefined)}</span>
                {value.timeSource === GpsSource.DEVICE && (
                  <span className="text-[11px] text-amber-600">({ms ? 'masa telefon' : 'device time'})</span>
                )}
              </div>
            )}
            {detectLocation && (
              <>
                <div className="flex items-center gap-2 text-slate-600">
                  <IconPin width={15} height={15} className={gpsOk ? 'text-slate-500' : 'text-red-400'} />
                  <span className={gpsOk ? '' : 'text-red-500'}>{gpsOk ? formatGps(value.gps) : ms ? 'Tiada lokasi' : formatGps(value.gps)}</span>
                  {sourceLabel && <span className="text-[11px] text-slate-500">({sourceLabel})</span>}
                </div>
                {!gpsOk && (
                  <p className="text-[11px] text-red-500">
                    {ms ? 'Lokasi tiada. Benarkan akses lokasi.' : 'No location found. Allow location access, or upload a photo that has GPS.'}
                  </p>
                )}
              </>
            )}
            {detecting && (
              <p className="text-[11px] text-slate-500">{ms ? 'Membaca tarikh dan lokasi…' : 'Reading date & location…'}</p>
            )}
            {value.blob?.size != null && (
              <p className="text-[11px] text-slate-500">{ms ? 'Saiz' : 'Upload size'} ≈ {formatBytes(value.blob.size)}</p>
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
