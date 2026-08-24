// GPS distance recorder for the operator map section, plus KML/GPX exporters.
//
// Recording runs on navigator.geolocation.watchPosition and works fully
// offline (map tiles need network, but the GPS track and distance don't).
// Noise handling: points are dropped when the fix is too inaccurate, closer
// than the jitter threshold, or would imply an impossible speed for ground
// machinery. Distance is the haversine sum over the accepted points.
//
// PWA limitation: browsers stop delivering GPS updates when the screen turns
// off, so the recorder requests a screen Wake Lock while recording (best
// effort) and the UI tells the operator to keep the app open.

const EARTH_R = 6371008.8 // mean earth radius, meters

/** Haversine distance in meters between two {lat, lng} points. */
export function haversine(a, b) {
  const rad = (d) => (d * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(s))
}

/** Sum of haversine segments over [{lat,lng},...]. */
export function trackDistance(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += haversine(points[i - 1], points[i])
  return total
}

// Start unlocks (and fixes are accepted) at ≤50 m. Coarse fixes still measure
// usefully because distance is summed fix-to-fix — a shared offset cancels —
// and the adaptive floor below only counts steps larger than a fraction of the
// reported error. Precision sharpens automatically as the fix tightens.
export const MAX_ACCURACY_M = 50
// Starting demands a tighter fix than recording does. A real satellite lock
// reaches well under this outdoors within seconds, so it proves the phone isn't
// falling back to Wi-Fi/cell positioning. Once moving, a looser fix is still
// better than skipping it — a skipped stretch is filled by a straight line.
export const START_ACCURACY_M = 30
const MIN_STEP_M = 2.5 // ignore jitter below this step
const MIN_SPEED_MS = 0.3 // below this the machine is considered stationary
const MAX_SPEED_MS = 40 // ignore impossible jumps (>144 km/h)
const MAX_POINTS = 20000 // hard cap per recording (~several work hours)

/**
 * Live GPS recorder. Callbacks: onUpdate({points, distance, lastFix, paused}),
 * onError(message). Usage: start() → pause()/resume() → stop() → returns
 * {points, distance, startedAt, endedAt}.
 */
export class TrackRecorder {
  constructor({ onUpdate, onError } = {}) {
    this.onUpdate = onUpdate || (() => {})
    this.onError = onError || (() => {})
    this.points = [] // accepted [{lat, lng, t}]
    this.distance = 0
    this.paused = false
    this.watchId = null
    this.wakeLock = null
    this.startedAt = null
    this.lastFix = null // latest raw fix (even if rejected), for the map cursor
    this._ema = null // accuracy-weighted smoothed position
    this._break = false // next accepted point starts a new segment (no distance)
    this._anchor = null // positional-measurement reference {lat,lng,t}
    this._lastT = null // timestamp of the previous accepted fix (Doppler dt)
  }

  get running() {
    return this.watchId != null
  }

  async start() {
    if (this.running) return
    if (!navigator.geolocation) {
      this.onError('GPS is not available on this device.')
      return
    }
    this.startedAt = this.startedAt || new Date().toISOString()
    this.paused = false
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._onFix(pos),
      (err) =>
        this.onError(
          err.code === 1
            ? 'Location is blocked for this site. Tap the lock icon next to the address → Permissions → Location → Allow, then reload.'
            : 'GPS signal lost — keep moving in the open.'
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    )
    await this._acquireWakeLock()
    this._emit()
  }

  pause() {
    this.paused = true
    this._emit()
  }

  resume() {
    this.paused = false
    // The machine may have moved while paused — that travel must NOT count.
    // Break the segment (re-anchor on the next fix, add no distance) and
    // restart smoothing fresh so the position snaps to wherever they are now.
    this._break = true
    this._ema = null
    this._lastT = null
    this._emit()
  }

  /** Stop recording and return the final track. */
  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId)
    this.watchId = null
    this._releaseWakeLock()
    return {
      points: this.points,
      distance: this.distance,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString()
    }
  }

  _onFix(pos) {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords
    const speed = pos.coords.speed // m/s from GPS Doppler; null when unsupported
    const t = pos.timestamp || Date.now()
    // heading = course over ground in degrees from north (null when stationary);
    // the map uses it for the direction triangle when the compass is silent.
    this.lastFix = { lat, lng, accuracy, t, heading: pos.coords.heading ?? null, speed: speed ?? null }
    if (this.paused) return this._emit()
    if (accuracy != null && accuracy > MAX_ACCURACY_M) return this._emit()

    // Accuracy-weighted smoothing: a tight fix (≤8 m) moves the smoothed
    // position fully; a loose one is damped. Floor of 0.35 keeps the dot/line
    // responsive — heavier damping made the track feel choppy and laggy.
    let w = accuracy != null ? Math.min(Math.max(8 / accuracy, 0.35), 1) : 0.5
    // ...but damping must not swallow real movement. When the raw fix has moved
    // clearly further than the error radius, that's travel rather than scatter,
    // so follow it almost exactly. Without this the smoothed point trails on
    // pulling away from a standstill and those first metres are lost for good.
    // Math.max, never a plain assignment: at a tight fix w is already 1 (no
    // damping at all) and forcing 0.9 would make fast, accurate travel worse.
    if (this._ema && haversine(this._ema, { lat, lng }) > Math.max(accuracy ?? 0, 4)) w = Math.max(w, 0.9)
    const s = this._ema
      ? { lat: this._ema.lat + (lat - this._ema.lat) * w, lng: this._ema.lng + (lng - this._ema.lng) * w }
      : { lat, lng }
    this._ema = s

    const dt = this._lastT != null ? (t - this._lastT) / 1000 : null
    this._lastT = t

    // Fresh start / just resumed: set the reference, count nothing yet.
    if (this._break || !this._anchor) {
      this._break = false
      this._anchor = { ...s, t }
      if (this.points.length < MAX_POINTS) this.points.push({ lat: s.lat, lng: s.lng, t })
      return this._emit()
    }

    // 1) Preferred: integrate the chip's Doppler-derived speed. It comes from
    //    satellite signal frequency shift, so it is UNAFFECTED by the absolute
    //    position error — accurate distance even on a ±100 m fix.
    const dopplerOk =
      speed != null && Number.isFinite(speed) && speed >= 0 && speed <= MAX_SPEED_MS && dt != null && dt > 0 && dt <= 3
    if (dopplerOk) {
      if (speed >= MIN_SPEED_MS) this.distance += speed * dt
      this._anchor = { ...s, t } // stretch consumed — positional must not recount it
    } else {
      // 2) Fallback: positional delta from the anchor, counted once the step
      //    clears the accuracy-scaled noise floor. A quarter of the error
      //    radius (the EMA already damps scatter) — half made the count jump
      //    in big chunks and feel choppy.
      const d = haversine(this._anchor, s)
      const adt = Math.max((t - this._anchor.t) / 1000, 0.001)
      // Capped: at a loose fix the old rule demanded a big step before anything
      // counted, so walking pace registered nothing for the first several metres.
      const minStep = Math.min(Math.max(MIN_STEP_M, (accuracy ?? 0) * 0.25), 6)
      if (d >= minStep && d / adt <= MAX_SPEED_MS) {
        this.distance += d
        this._anchor = { ...s, t }
      }
    }

    // Track-line detail: record a point whenever we've moved a little.
    const lastPt = this.points[this.points.length - 1]
    if (lastPt && haversine(lastPt, s) >= MIN_STEP_M && this.points.length < MAX_POINTS) {
      this.points.push({ lat: s.lat, lng: s.lng, t })
    }
    this._emit()
  }

  _emit() {
    this.onUpdate({ points: this.points, distance: this.distance, lastFix: this.lastFix, paused: this.paused })
  }

  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen')
        // Reacquire if the tab regains visibility (lock is released on hide).
        this._onVis = async () => {
          if (document.visibilityState === 'visible' && this.running && !this.wakeLock) {
            try {
              this.wakeLock = await navigator.wakeLock.request('screen')
            } catch {
              /* best effort */
            }
          }
        }
        document.addEventListener('visibilitychange', this._onVis)
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null
        })
      }
    } catch {
      /* wake lock unsupported/denied — recording still works while screen is on */
    }
  }

  _releaseWakeLock() {
    if (this._onVis) document.removeEventListener('visibilitychange', this._onVis)
    try {
      this.wakeLock?.release()
    } catch {
      /* already released */
    }
    this.wakeLock = null
  }
}

// ---------------------------------------------------------------------------
// Export: month of tracks → KML or GPX text
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Exports carry the PATH GEOMETRY ONLY — no per-point timestamps, no job /
// piece-rate names, no dates or distances. Just the lines, so the file can be
// dropped into Google Earth / QGIS without leaking record details.

/** tracks: [{points:[{lat,lng}], ...}] — everything but the geometry is ignored. */
export function tracksToKML(tracks, docName = 'Tracks') {
  const placemarks = tracks
    .map((tr, i) => {
      const coords = tr.points.map((p) => `${p.lng},${p.lat},0`).join(' ')
      return `    <Placemark>
      <name>Path ${i + 1}</name>
      <styleUrl>#track</styleUrl>
      <LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>
    </Placemark>`
    })
    .join('\n')
  // Same blue the app draws tracks in (#3b82f6). KML colours are aabbggrr, so
  // that's fff6823b. GPX has no styling at all, so this makes both look alike.
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${esc(docName)}</name>
    <Style id="track"><LineStyle><color>fff6823b</color><width>4</width></LineStyle></Style>
${placemarks}
  </Document>
</kml>`
}

export function tracksToGPX(tracks, docName = 'Tracks') {
  const trks = tracks
    .map((tr, i) => {
      const pts = tr.points.map((p) => `      <trkpt lat="${p.lat}" lon="${p.lng}" />`).join('\n')
      return `  <trk>
    <name>Path ${i + 1}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MachTrek" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(docName)}</name></metadata>
${trks}
</gpx>`
}

/** Trigger a client-side file download. */
export function downloadFile(filename, text, mime = 'application/octet-stream') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
