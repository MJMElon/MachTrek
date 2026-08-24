import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useLiveQuery } from 'dexie-react-hooks'
import { TrackRecorder, MAX_ACCURACY_M, START_ACCURACY_M, trackDistance } from '../lib/geotrack.js'
import { addTrack, listTracks, deleteTrack, updateTrackPoints } from '../db/repo.js'
import { monthKeyOf, monthLabel } from '../lib/format.js'
import { tracksToKML, tracksToGPX, downloadFile } from '../lib/geotrack.js'
import { Button } from './ui.jsx'

// Free satellite imagery (no API key). Looks like Google's satellite view.
const SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const SAT_ATTRIB = 'Imagery © Esri'
const FALLBACK_CENTER = [4.2105, 108.9758] // Malaysia-ish, used only before the first GPS fix
// A diagonal-sized square covers a rectangular viewport at every rotation.
// Extra pixels prevent sub-pixel/anti-aliasing seams along the clipped edges.
const ROTATION_SURFACE_PADDING_PX = 16

const fmtM = (m) => `${(Math.round(m * 10) / 10).toLocaleString()} m`
/** Elapsed seconds -> "m:ss" (or "h:mm:ss" past an hour). */
const fmtElapsed = (s) => {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}
const dateOnly = (iso, locale) =>
  iso ? new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
// Always 24-hour (e.g. 14:30) regardless of the phone's own time setting.
const timeOnly = (iso, locale) =>
  iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'

/**
 * Full-screen satellite-map overlay where an operator records the distance
 * they drive for meter-unit piece work. Start / Pause / End(save); the saved
 * distance is reported to the parent (which locks it into the task quantity).
 * This month's earlier recordings are drawn underneath and exportable KML/GPX.
 *
 * Recording and boundaries work offline. Satellite imagery is cached on demand,
 * so previously viewed tiles can also reappear without a connection.
 */
export default function DistanceRecorder({
  open,
  onClose,
  session,
  taskId,
  pieceRate,
  onSaved,
  // Admin view: show given tracks on the map, inspect + export them, but no
  // recording controls and no GPS/wake-lock/notification usage at all.
  readOnly = false,
  tracks: tracksProp = null,
  title = null,
  // Company site outline (parsed KML/GPX), drawn under everything else.
  boundary = null,
  // Managers: site + HQ admin may draw a path (needs drawTarget); only HQ admin
  // may delete one. Operators get neither.
  canDraw = false,
  canDelete = false,
  // When set, deletion is limited to paths of that task — an operator may only
  // remove paths from the job they're finishing, not earlier ones.
  deletableTaskId = null,
  deleteLabel = 'Delete',
  deleteConfirm = null, // full confirm text; falls back to English below
  canEditRecorded = false, // HQ admin may also reshape a GPS recording
  editedBy = null, // role stamped on a reshaped recording (monthly map has no drawTarget)
  focus = null, // [lat, lng] to open on when there are no paths/boundary to frame
  drawTarget = null, // { taskId, session: {operatorId, operatorName, companyId}, pieceRate, drawnBy }
  language = 'en'
}) {
  const ms = language === 'ms'
  const mapViewport = useRef(null) // visible, clipped rectangle
  const mapDiv = useRef(null)
  const mapRef = useRef(null)
  const liveLine = useRef(null) // polyline of the in-progress recording
  const liveCasing = useRef(null) // white outline under it
  const hereDot = useRef(null) // current-location marker
  const monthLayer = useRef(null) // this month's saved tracks
  const boundaryLayer = useRef(null) // company site outline
  const recorder = useRef(null)

  const [rec, setRec] = useState({ running: false, paused: false, distance: 0, points: [], lastFix: null })
  const [fix, setFix] = useState(null) // warm-up GPS fix while idle (gates Start)
  const [elapsed, setElapsed] = useState(0) // seconds since recording started
  const centered = useRef(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  // Format chooser target: null = closed, 'month' = all of this month's tracks,
  // or a single track object (exported from its detail panel).
  const [exportTarget, setExportTarget] = useState(null)
  const [selected, setSelected] = useState(null) // past track tapped on the map
  // Admin draw mode: tap the map to lay points; distance is the haversine sum.
  const [drawing, setDrawing] = useState(false)
  const [drawPts, setDrawPts] = useState([])
  const drawLine = useRef(null)
  const handleLayer = useRef(null) // draggable vertex + insert handles
  const drawingRef = useRef(false)
  const [editingId, setEditingId] = useState(null) // saved drawn path being reshaped
  useEffect(() => {
    drawingRef.current = drawing
  }, [drawing])
  const committedDistance = useMemo(
    () => trackDistance(drawPts.map(([lat, lng]) => ({ lat, lng }))),
    [drawPts]
  )
  // During a vertex drag the points aren't committed to state yet (that would
  // rebuild the handles mid-gesture), so the live figure is tracked separately.
  const [dragDistance, setDragDistance] = useState(null)
  const drawDistance = dragDistance ?? committedDistance

  // Visual smoothing: GPS fixes land ~once a second, which looks choppy if the
  // dot/line/counter jump to each fix. A 60fps loop glides the shown position
  // and meter count toward the latest real values instead. Display only — the
  // measured distance itself is untouched.
  const distEl = useRef(null) // big meter readout, updated imperatively
  const smooth = useRef({
    pos: null,
    target: null,
    linePts: [],
    extendLine: false,
    dist: 0,
    distTarget: 0,
    headShown: 0, // displayed heading (deg), eased toward headTarget
    headTarget: null,
    headAt: 0, // when the compass last spoke (GPS course fills long silences)
    wrapShown: 0 // current map rotation (heading-up mode)
  })
  const rotWrap = useRef(null) // rotating wrapper around the map (heading-up mode)
  const dotInner = useRef(null) // the dot/triangle element, rotated to the heading
  const zooming = useRef(false) // pause follow-centering during a pinch/zoom
  // Follow mode, cycled by the compass button: 0 = free, 1 = follow (north-up),
  // 2 = follow + rotate with facing direction. Recording forces mode 1 on start.
  const [followMode, setFollowMode] = useState(1)
  const modeRef = useRef(1)
  useEffect(() => {
    modeRef.current = followMode
  }, [followMode])

  const monthKey = monthKeyOf(new Date())
  const queriedTracks = useLiveQuery(
    () => (open && !tracksProp && session?.operatorId ? listTracks({ operatorId: session.operatorId, monthKey }) : []),
    [open, tracksProp, session?.operatorId, monthKey],
    []
  )
  const monthTracks = tracksProp ?? queriedTracks
  const monthTotal = useMemo(
    () => (monthTracks || []).reduce((s, t) => s + (Number(t.distanceMeters) || 0), 0),
    [monthTracks]
  )

  useEffect(() => {
    const wentOnline = () => setOnline(true)
    const wentOffline = () => setOnline(false)
    window.addEventListener('online', wentOnline)
    window.addEventListener('offline', wentOffline)
    return () => {
      window.removeEventListener('online', wentOnline)
      window.removeEventListener('offline', wentOffline)
    }
  }, [])

  // Create the map when the overlay opens, destroy it when it closes.
  useEffect(() => {
    if (!open || !mapDiv.current) return
    // No Leaflet corner controls: the map div is oversized for rotation, so its
    // corners sit off-screen — zoom is pinch/scroll, credit is our own overlay.
    const map = L.map(mapDiv.current, { zoomControl: false, attributionControl: false, maxZoom: 22 })
    // Imagery is native up to z19; beyond that Leaflet upscales the same tiles.
    // Blurrier, but it makes placing/dragging vertices much easier.
    L.tileLayer(SAT_TILES, { maxNativeZoom: 19, maxZoom: 22 }).addTo(map)
    map.setView(FALLBACK_CENTER, 6)
    mapRef.current = map
    // Company boundary sits under the tracks (added first).
    boundaryLayer.current = L.featureGroup().addTo(map)
    // featureGroup (not layerGroup) — it's the one that exposes getBounds(),
    // which the read-only view uses to frame the recorded paths.
    monthLayer.current = L.featureGroup().addTo(map)
    // Live recording line, white-cased for the same reason as the saved tracks.
    liveCasing.current = L.polyline([], { color: '#ffffff', weight: 7, opacity: 0.85 }).addTo(map)
    liveLine.current = L.polyline([], { color: '#ef4444', weight: 4 }).addTo(map)
    // Current-position marker: blue dot with a triangle "beak" showing the
    // facing/travel direction (rotated each frame by the glide loop).
    hereDot.current = L.marker(FALLBACK_CENTER, {
      interactive: false,
      zIndexOffset: 1000,
      icon: L.divIcon({
        className: '',
        iconSize: [40, 40],
        iconAnchor: [20, 20],
        html:
          '<div style="width:40px;height:40px;will-change:transform">' +
          '<svg viewBox="0 0 40 40" width="40" height="40" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">' +
          '<polygon points="20,2 27,13 13,13" fill="#2563eb" stroke="#ffffff" stroke-width="1.5"/>' +
          '<circle cx="20" cy="22" r="9" fill="#2563eb" stroke="#ffffff" stroke-width="2.5"/>' +
          '</svg></div>'
      })
    }).addTo(map)
    dotInner.current = hereDot.current.getElement()?.firstElementChild || null
    if (readOnly) hereDot.current.remove() // no live position in the admin view
    // Pause follow-centering while the operator pinches/zooms.
    map.on('zoomstart', () => (zooming.current = true))
    map.on('zoomend', () => (zooming.current = false))
    // Draw mode consumes taps as points; otherwise a tap clears the selection
    // (track taps don't bubble up here).
    drawLine.current = L.polyline([], { color: '#22c55e', weight: 5, dashArray: '8 5' }).addTo(map)
    handleLayer.current = L.layerGroup().addTo(map)
    map.on('click', (e) => {
      if (drawingRef.current) setDrawPts((p) => [...p, [e.latlng.lat, e.latlng.lng]])
      else setSelected(null)
    })

    // The overlay animates in — Leaflet needs a size poke once it's visible.
    setTimeout(() => mapRef.current?.invalidateSize(), 60)

    return () => {
      recorder.current?.stop()
      recorder.current = null
      map.remove()
      mapRef.current = null
      centered.current = false
      resetSmooth()
      smooth.current.pos = null
      smooth.current.target = null
      setRec({ running: false, paused: false, distance: 0, points: [], lastFix: null })
      setFix(null)
      setSelected(null)
      setExportTarget(null)
      setError('')
    }
  }, [open])

  // Shortest-way easing between two angles (handles the 359°→1° wrap).
  const easeAngle = (cur, target, k) => cur + ((((target - cur + 540) % 360) - 180) * k)

  // Size the rotating map as a square whose side is the visible viewport's
  // diagonal. That is the smallest square guaranteed to cover every corner at
  // every compass angle, without the tile/memory cost of a large fixed percent.
  // This layout effect runs before Leaflet is created, then re-measures only
  // when the viewport changes (including phone rotation and dynamic UI resize).
  useLayoutEffect(() => {
    if (!open) return
    const resizeSurface = () => {
      const viewport = mapViewport.current
      const wrapper = rotWrap.current
      if (!viewport || !wrapper) return

      const { width, height } = viewport.getBoundingClientRect()
      if (!width || !height) return

      const side = Math.ceil(Math.hypot(width, height)) + ROTATION_SURFACE_PADDING_PX
      const size = `${side}px`
      if (wrapper.style.width === size && wrapper.style.height === size) return

      wrapper.style.width = size
      wrapper.style.height = size
      mapRef.current?.invalidateSize({ pan: false })
    }

    resizeSurface()
    const refresh = () => resizeSurface()
    window.addEventListener('resize', refresh)
    window.addEventListener('orientationchange', refresh)
    let ro
    if (typeof ResizeObserver !== 'undefined' && mapViewport.current) {
      ro = new ResizeObserver(resizeSurface)
      ro.observe(mapViewport.current)
    }
    return () => {
      window.removeEventListener('resize', refresh)
      window.removeEventListener('orientationchange', refresh)
      ro?.disconnect()
    }
  }, [open])

  // Recording timer — ticks every second so the operator can see it's live.
  useEffect(() => {
    if (!rec.running) return setElapsed(0)
    const startedAt = recorder.current?.startedAt ? new Date(recorder.current.startedAt).getTime() : Date.now()
    const tick = () => setElapsed((Date.now() - startedAt) / 1000)
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [rec.running])

  // Errors are transient notices — clear them so they don't sit over the map.
  useEffect(() => {
    if (!error) return
    const id = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(id)
  }, [error])

  // The 60fps glide loop (exponential approach: each frame closes ~12-15% of
  // the remaining gap, so motion is fluid and settles fast without overshoot).
  useEffect(() => {
    if (!open) return
    let raf
    const tick = () => {
      const s = smooth.current
      if (s.target) {
        s.pos = s.pos
          ? [s.pos[0] + (s.target[0] - s.pos[0]) * 0.12, s.pos[1] + (s.target[1] - s.pos[1]) * 0.12]
          : s.target
        hereDot.current?.setLatLng(s.pos)
        // The live red line (and its casing) grows continuously to the dot.
        const live = s.extendLine ? [...s.linePts, s.pos] : s.linePts
        liveCasing.current?.setLatLngs(live)
        liveLine.current?.setLatLngs(live)
        // Follow modes keep the machine centered (skipped mid-pinch so zoom
        // gestures aren't cancelled). Free mode leaves the map alone.
        if (modeRef.current >= 1 && !zooming.current && mapRef.current) {
          mapRef.current.panTo(s.pos, { animate: false })
        }
      }
      // Heading: rotate the dot's triangle; in heading-up mode counter-rotate
      // the whole map so "forward" is up (the triangle then points up too).
      if (s.headTarget != null) {
        s.headShown = easeAngle(s.headShown, s.headTarget, 0.15)
        if (dotInner.current) dotInner.current.style.transform = `rotate(${s.headShown}deg)`
      }
      const wrapTarget = modeRef.current === 2 && s.headTarget != null ? -s.headShown : 0
      s.wrapShown = easeAngle(s.wrapShown, wrapTarget, 0.15)
      if (rotWrap.current) {
        rotWrap.current.style.transform = `translate(-50%, -50%) rotate(${s.wrapShown}deg)`
      }
      s.dist += (s.distTarget - s.dist) * 0.15
      if (Math.abs(s.distTarget - s.dist) < 0.05) s.dist = s.distTarget
      if (distEl.current) distEl.current.textContent = fmtM(s.dist)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open])

  // Facing direction from the device compass; GPS course-over-ground fills in
  // while the compass is silent and the machine is moving.
  useEffect(() => {
    if (!open) return
    const onOrient = (e) => {
      let h = null
      if (e.webkitCompassHeading != null) h = e.webkitCompassHeading // iOS
      else if (e.alpha != null && (e.absolute || e.type === 'deviceorientationabsolute')) h = (360 - e.alpha) % 360
      if (h != null && Number.isFinite(h)) {
        smooth.current.headTarget = h
        smooth.current.headAt = Date.now()
      }
    }
    window.addEventListener('deviceorientationabsolute', onOrient)
    window.addEventListener('deviceorientation', onOrient)
    return () => {
      window.removeEventListener('deviceorientationabsolute', onOrient)
      window.removeEventListener('deviceorientation', onOrient)
    }
  }, [open])

  // GPS course fallback for the triangle (only when the compass hasn't spoken
  // recently and we're actually moving — course is meaningless when parked).
  function gpsHeadingFallback(heading, speed) {
    if (heading == null || !Number.isFinite(heading)) return
    if ((speed ?? 0) < 0.5) return
    if (Date.now() - smooth.current.headAt < 3000) return
    smooth.current.headTarget = heading
  }

  // If location is hard-blocked for this site, say so (with the fix) the
  // moment the map opens — a denied state can never re-prompt, so waiting on
  // GPS would just look broken.
  useEffect(() => {
    if (!open || readOnly || !navigator.permissions?.query) return
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((st) => {
        if (st.state === 'denied')
          setError(ms ? 'Lokasi disekat. Benarkan lokasi dalam tetapan pelayar.' : 'Location is blocked for this site. Tap the lock icon next to the address → Permissions → Location → Allow, then reload.')
      })
      .catch(() => {})
  }, [open, readOnly, ms])

  // Warm up the GPS from the moment the map opens: a live watch that moves the
  // blue dot, centers the map on the first fix, and reports accuracy so Start
  // stays disabled until the fix is tight enough to measure with. (While
  // recording, the recorder's own watch takes over feeding the dot.)
  useEffect(() => {
    if (!open || readOnly || rec.running || !navigator.geolocation) return
    const wid = navigator.geolocation.watchPosition(
      (pos) => {
        const f = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null }
        setFix(f)
        smooth.current.target = [f.lat, f.lng] // dot glides there via the rAF loop
        gpsHeadingFallback(pos.coords.heading, pos.coords.speed)
        if (!centered.current && mapRef.current) {
          centered.current = true
          mapRef.current.setView([f.lat, f.lng], 18)
        }
      },
      (err) => {
        if (err.code === 1)
          setError(ms ? 'Lokasi disekat. Benarkan lokasi dalam tetapan pelayar.' : 'Location is blocked for this site. Tap the lock icon next to the address → Permissions → Location → Allow, then reload.')
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    )
    return () => navigator.geolocation.clearWatch(wid)
  }, [open, readOnly, rec.running, ms])

  // Mirror the drawn points onto the map line, and rebuild the edit handles:
  // a solid dot per vertex (drag to move, tap to delete) and a hollow dot at
  // each midpoint (drag or tap to insert a new vertex there).
  useEffect(() => {
    drawLine.current?.setLatLngs(drawPts)
    const layer = handleLayer.current
    if (!layer) return
    layer.clearLayers()
    if (!drawing) return

    const dot = (fill, size) =>
      L.divIcon({
        className: '',
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>`
      })

    drawPts.forEach((p, i) => {
      const m = L.marker(p, { draggable: true, icon: dot('#22c55e', 18), zIndexOffset: 900 }).addTo(layer)
      // Live-update the line while dragging; commit to state on release.
      m.on('drag', (e) => {
        const ll = e.target.getLatLng()
        const next = drawPts.map((q, j) => (j === i ? [ll.lat, ll.lng] : q))
        drawLine.current?.setLatLngs(next)
        setDragDistance(trackDistance(next.map(([lat, lng]) => ({ lat, lng })))) // live readout
      })
      m.on('dragend', (e) => {
        const ll = e.target.getLatLng()
        setDrawPts((prev) => prev.map((q, j) => (j === i ? [ll.lat, ll.lng] : q)))
        setDragDistance(null) // committed — fall back to the computed value
      })
      // Tap a vertex to remove it (keep at least two points).
      m.on('click', () => setDrawPts((prev) => (prev.length > 2 ? prev.filter((_, j) => j !== i) : prev)))
    })

    for (let i = 1; i < drawPts.length; i++) {
      const a = drawPts[i - 1]
      const b = drawPts[i]
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const m = L.marker(mid, { draggable: true, icon: dot('rgba(34,197,94,.45)', 13), zIndexOffset: 800 }).addTo(layer)
      const insertAt = (ll) => setDrawPts((prev) => [...prev.slice(0, i), [ll.lat, ll.lng], ...prev.slice(i)])
      m.on('click', () => insertAt({ lat: mid[0], lng: mid[1] }))
      // Dragging a midpoint creates the vertex where it's dropped.
      m.on('dragend', (e) => insertAt(e.target.getLatLng()))
    }
  }, [drawPts, drawing])

  // Draw the company boundary: a background reference layer, non-interactive so
  // it never steals taps from the tracks.
  useEffect(() => {
    const layer = boundaryLayer.current
    if (!open || !layer) return
    layer.clearLayers()
    for (const f of boundary?.features || []) {
      if (!f?.coords?.length) continue
      const opts = { color: '#fbbf24', weight: 2, opacity: 0.95, interactive: false, dashArray: '6 4' }
      if (f.type === 'polygon') {
        L.polygon(f.coords, { ...opts, fillColor: '#fbbf24', fillOpacity: 0.08 }).addTo(layer)
      } else {
        L.polyline(f.coords, opts).addTo(layer)
      }
    }
  }, [open, boundary])

  // Draw this month's saved tracks (blue, under the live red line). Each one is
  // tappable to show its job / finish time / distance.
  useEffect(() => {
    const layer = monthLayer.current
    if (!open || !layer) return
    layer.clearLayers()
    for (const t of monthTracks || []) {
      if (!t.points?.length) continue
      if (t.id === editingId) continue // its green editable copy is on the map
      const latlngs = t.points.map((p) => [p.lat, p.lng])
      // Tap a track → highlight it and open a small popup pinned to the tap
      // point, showing the job, finish time and distance.
      // Tap a track → highlight it; details render in the fixed right-hand
      // panel (never over the map lines).
      const show = () => setSelected(t)
      const isSel = selected?.id === t.id
      // Casing under every track so it reads against dark/bright satellite
      // imagery: white for normal tracks, near-black under the selected one
      // (which is amber, so a dark casing gives the strongest contrast).
      L.polyline(latlngs, {
        color: isSel ? '#111827' : '#ffffff',
        weight: isSel ? 9 : 6,
        opacity: isSel ? 0.9 : 0.85,
        bubblingMouseEvents: false
      })
        .addTo(layer)
        .on('click', show)
      L.polyline(latlngs, {
        color: isSel ? '#facc15' : '#3b82f6',
        weight: isSel ? 5 : 3,
        opacity: 1,
        bubblingMouseEvents: false
      })
        .addTo(layer)
        .on('click', show)
      // Invisible fat line on top — a 3px line is nearly impossible to tap
      // with a finger, so this widens the hit area without changing the look.
      L.polyline(latlngs, { color: '#000', weight: 22, opacity: 0, bubblingMouseEvents: false })
        .addTo(layer)
        .on('click', show)
    }
    // Admin view has no live position to centre on — frame the tracks instead.
    // Deferred so the (oversized, rotating) container has its real size first;
    // fitting against a stale size picks a far-too-wide zoom.
    if (readOnly && !centered.current) {
      // Prefer the tracks; fall back to the boundary when there are none (so the
      // map still opens somewhere meaningful rather than the world view).
      let b = layer.getBounds?.()
      if (!b?.isValid()) b = boundaryLayer.current?.getBounds?.()
      const m = mapRef.current
      if (b?.isValid()) {
        centered.current = true
        setTimeout(() => {
          m?.invalidateSize()
          m?.fitBounds(b, { padding: [40, 40], maxZoom: 18 })
        }, 90)
      } else if (focus?.[0] != null) {
        // Nothing to frame — open where the work actually happened.
        centered.current = true
        setTimeout(() => {
          m?.invalidateSize()
          m?.setView(focus, 17)
        }, 90)
      }
    }
  }, [open, monthTracks, selected, readOnly, editingId, focus])

  function onUpdate({ points, distance, lastFix, paused }) {
    setRec({ running: !!recorder.current?.running, paused, distance, points, lastFix })
    // Feed the glide loop — it moves the dot, grows the line, counts the meter,
    // and (in follow modes) keeps the machine centered.
    const s = smooth.current
    if (lastFix) {
      s.target = [lastFix.lat, lastFix.lng]
      gpsHeadingFallback(lastFix.heading, lastFix.speed)
    }
    s.linePts = points.map((p) => [p.lat, p.lng])
    s.extendLine = !!recorder.current?.running && !paused
    s.distTarget = distance
  }

  async function start() {
    setError('')
    const onRecorderError = (message) => {
      if (!ms) return setError(message)
      if (/not available/i.test(message)) return setError('GPS tidak tersedia.')
      if (/blocked/i.test(message)) return setError('Lokasi disekat. Benarkan lokasi dalam tetapan pelayar.')
      setError('Isyarat GPS hilang. Cuba di kawasan terbuka.')
    }
    recorder.current = new TrackRecorder({ onUpdate, onError: onRecorderError })
    await recorder.current.start()
    setRec((r) => ({ ...r, running: true, paused: false }))
    // While recording: always follow the dot, and cap how far out the operator
    // can zoom so the recorded trail stays visible on screen.
    setFollowMode((m) => (m === 0 ? 1 : m))
    mapRef.current?.setMinZoom(15)
  }

  // Compass button: recenter+follow → rotate-with-heading → free.
  function cycleFollowMode() {
    setFollowMode((m) => {
      const next = (m + 1) % 3
      if (next === 1) {
        // Snap back to the machine at a working zoom, keep following north-up.
        const p = smooth.current.pos || smooth.current.target
        if (p && mapRef.current) mapRef.current.setView(p, Math.max(mapRef.current.getZoom(), 17))
      }
      if (next === 2) {
        // iOS only grants compass data after an explicit ask inside a tap.
        try {
          if (typeof DeviceOrientationEvent !== 'undefined') DeviceOrientationEvent.requestPermission?.().catch(() => {})
        } catch {
          /* not iOS */
        }
      }
      return next
    })
  }


  // ---- Admin: delete a path, or draw one by tapping the map --------------

  async function removeSelected() {
    if (!selected) return
    const ask = deleteConfirm || `Delete this ${fmtM(selected.distanceMeters)} path? The quantity updates everywhere.`
    if (!window.confirm(ask.replace('{d}', fmtM(selected.distanceMeters)))) return
    setSaving(true)
    try {
      await deleteTrack(selected.id)
      setSelected(null)
    } catch (e) {
      setError(e.message || 'Could not delete that path.')
    } finally {
      setSaving(false)
    }
  }

  async function saveDrawn() {
    if (drawPts.length < 2) return
    const pts = drawPts.map(([lat, lng]) => ({ lat, lng, t: 0 }))
    setSaving(true)
    try {
      if (editingId) {
        // Reshaped an existing path (drawn, or a recording when HQ admin).
        await updateTrackPoints(editingId, pts, drawDistance, {
          allowRecorded: canEditRecorded,
          editedBy: editedBy || drawTarget?.drawnBy || 'HQ admin'
        })
      } else {
        if (!drawTarget) return
        await addTrack({
          session: drawTarget.session,
          taskId: drawTarget.taskId,
          pieceRate: drawTarget.pieceRate,
          points: pts,
          distanceMeters: drawDistance,
          manual: true,
          drawnBy: drawTarget.drawnBy || null
        })
      }
      cancelDraw()
    } catch (e) {
      setError(e.message || 'Could not save the drawn path.')
    } finally {
      setSaving(false)
    }
  }

  function cancelDraw() {
    setDrawing(false)
    setDrawPts([])
    setEditingId(null)
  }

  // Reshape a saved path: load its points into draw mode. The recording's
  // original date/time is never changed — only its geometry.
  function editSelected() {
    if (!selected) return
    if (!(selected.manual ? canDraw : canEditRecorded)) return
    setDrawPts((selected.points || []).map((p) => [p.lat, p.lng]))
    setEditingId(selected.id)
    setSelected(null)
    setDrawing(true)
  }

  // Snap the glide layer back to zero (line cleared, counter reset).
  function resetSmooth() {
    const s = smooth.current
    s.linePts = []
    s.extendLine = false
    s.dist = 0
    s.distTarget = 0
  }

  async function endAndSave() {
    const r = recorder.current
    if (!r) return
    const result = r.stop()
    recorder.current = null
    mapRef.current?.setMinZoom(1) // recording over — release the zoom-out cap
    if (!result.points.length || result.distance <= 0) {
      // Nothing measured — just reset, don't save an empty track.
      setRec({ running: false, paused: false, distance: 0, points: [] })
      resetSmooth()
      setError(result.points.length ? '' : ms ? 'Tiada pergerakan direkod.' : 'No movement recorded — nothing to save.')
      return
    }
    setSaving(true)
    try {
      await addTrack({
        session,
        taskId,
        pieceRate,
        points: result.points,
        distanceMeters: result.distance,
        startedAt: result.startedAt,
        endedAt: result.endedAt
      })
      resetSmooth()
      setRec({ running: false, paused: false, distance: 0, points: [] })
      onSaved?.() // parent re-reads the task total and locks the quantity
    } catch (err) {
      setError(ms ? 'Gagal simpan rekod.' : err.message || 'Could not save the recording.')
    } finally {
      setSaving(false)
    }
  }

  // Paths only — the exporters deliberately drop timestamps, job names and
  // distances, so the file is just the drawn lines. Target is either the whole
  // month or one selected track.
  function runExport(kind) {
    const target = exportTarget
    if (!target) return
    const single = target !== 'month'
    const source = single ? [target] : monthTracks || []
    const tracks = source.filter((t) => t.points?.length).map((t) => ({ points: t.points }))
    if (!tracks.length) return
    setExportTarget(null)
    const who = session?.operatorName || 'Operator'
    const slug = who.replace(/\s+/g, '_')
    const docName = single ? `${who} — ${dateOnly(target.startedAt)}` : `${who} — ${monthLabel(monthKey)}`
    const stamp = single ? `${target.dayKey}_${timeOnly(target.startedAt).replace(':', '')}` : monthKey
    const base = `${slug}_path${single ? '' : 's'}_${stamp}`
    if (kind === 'kml') downloadFile(`${base}.kml`, tracksToKML(tracks, docName), 'application/vnd.google-earth.kml+xml')
    else downloadFile(`${base}.gpx`, tracksToGPX(tracks, docName), 'application/gpx+xml')
  }

  if (!open) return null
  const idle = !rec.running
  const hasExport = idle && (monthTracks || []).some((t) => t.points?.length)
  // What the export dialog is about to write (a track chooser closes with its
  // detail panel, so guard on `selected` too).
  const exportOpen = exportTarget && (exportTarget === 'month' || selected)
  const exportList = exportOpen
    ? (exportTarget === 'month' ? monthTracks || [] : [exportTarget]).filter((t) => t.points?.length)
    : []
  const exportMeters = exportList.reduce((s, t) => s + (Number(t.distanceMeters) || 0), 0)
  // Gate Start on a fix at least as tight as what the recorder will accept —
  // otherwise the first points would be silently rejected anyway.
  const gpsReady = fix?.accuracy != null && fix.accuracy <= START_ACCURACY_M
  const accNow = rec.running ? rec.lastFix?.accuracy : fix?.accuracy
  // Green = ready to start, amber = usable while running, red = ignored.
  const accColor =
    accNow == null
      ? 'text-white/60'
      : accNow <= START_ACCURACY_M
        ? 'text-green-300'
        : accNow <= MAX_ACCURACY_M
          ? 'text-amber-300'
          : 'text-red-300'

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Map fills the screen. Its rotating wrapper is sized to this viewport's
          diagonal so heading-up mode cannot expose bare corners. */}
      <div ref={mapViewport} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={rotWrap}
          className="absolute left-1/2 top-1/2 h-full w-full will-change-transform"
          style={{ transform: 'translate(-50%, -50%) rotate(0deg)' }}
        >
          <div ref={mapDiv} className="h-full w-full" />
        </div>
      </div>

      {/* Export dialog — centered, says what will be written, picks the format */}
      {exportOpen && (
        <div
          className="absolute inset-0 z-[1100] flex items-center justify-center bg-black/50 p-6"
          onClick={() => setExportTarget(null)}
        >
          <div
            className="w-full max-w-[290px] rounded-2xl bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-base font-bold text-slate-800">
              {exportTarget !== 'month'
                ? ms ? 'Eksport trek' : 'Export this track'
                : readOnly
                  ? title || (ms ? 'Eksport laluan' : 'Export paths')
                  : `${ms ? 'Eksport' : 'Export'} ${monthLabel(monthKey, ms ? 'ms-MY' : undefined)}`}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {exportList.length} {ms ? 'trek' : `track${exportList.length === 1 ? '' : 's'}`} · {fmtM(exportMeters)}
            </p>
            <p className="mt-1 text-xs text-slate-500">{ms ? 'Pilih format:' : 'The file contains the path only. Choose a format:'}</p>
            <div className="mt-4 flex gap-2">
              <Button type="button" full onClick={() => runExport('kml')}>
                KML
              </Button>
              <Button type="button" full variant="secondary" onClick={() => runExport('gpx')}>
                GPX
              </Button>
            </div>
            {/* Google Earth's GPX importer ticks both "Create KML Tracks" and
                "Create KML LineStrings", which shows every path twice — KML has
                no such option, so point people there. */}
            <div className="mt-1.5 flex gap-2 text-center text-[10px] leading-tight text-slate-500">
              <span className="flex-1">Google Earth</span>
              <span className="flex-1">{ms ? 'Aplikasi GPS / GIS' : 'GPS apps / GIS'}</span>
            </div>
            <Button type="button" full variant="ghost" className="mt-2" onClick={() => setExportTarget(null)}>
              {ms ? 'Batal' : 'Cancel'}
            </Button>
          </div>
        </div>
      )}

      {/* Imagery credit (Leaflet's own attribution corner is off-screen) */}
      <span className="absolute left-1 top-1 z-[1000] rounded bg-black/40 px-1.5 py-0.5 text-[9px] text-white/60">
        {SAT_ATTRIB}
      </span>

      {!online && (
        <p
          role="status"
          className="absolute left-2 top-7 z-[1000] max-w-[70%] rounded-lg bg-amber-950/85 px-2.5 py-1.5 text-xs font-medium leading-tight text-amber-50 shadow"
        >
          {ms
            ? `Luar talian · ${boundary ? 'sempadan tersedia' : 'trek tersedia'} · imej tersimpan sahaja`
            : `Offline · ${boundary ? 'boundary saved' : 'saved tracks available'} · cached imagery only`}
        </p>
      )}

      {/* HQ admin: start drawing a path (sits above the compass) */}
      {readOnly && canDraw && drawTarget && !drawing && (
        <button
          type="button"
          onClick={() => setDrawing(true)}
          className="absolute bottom-40 right-3 z-[1000] flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-700 shadow-lg active:bg-slate-100"
          aria-label="Draw a path"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
      )}

      {/* Compass: recenter+follow → heading-up → free */}
      <button
        type="button"
        onClick={cycleFollowMode}
        className="absolute bottom-24 right-3 z-[1000] flex h-12 w-12 items-center justify-center rounded-full bg-white text-slate-700 shadow-lg active:bg-slate-100"
        aria-label={
          followMode === 0
            ? ms ? 'Ikut kedudukan' : 'Follow my position'
            : followMode === 1
              ? ms ? 'Putar ikut arah' : 'Rotate with facing direction'
              : ms ? 'Peta bebas' : 'Free map'
        }
      >
        {followMode === 2 ? (
          /* heading-up: compass needle */
          <svg viewBox="0 0 24 24" width="26" height="26">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-brand" />
            <polygon points="12,4 15,12 12,10.5 9,12" fill="#dc2626" />
            <polygon points="12,20 9,12 12,13.5 15,12" fill="#94a3b8" />
          </svg>
        ) : followMode === 1 ? (
          /* following, north-up: filled crosshair */
          <svg viewBox="0 0 24 24" width="26" height="26" className="text-brand">
            <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="12" cy="12" r="3" fill="currentColor" />
            <path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          /* free: hollow crosshair */
          <svg viewBox="0 0 24 24" width="26" height="26" className="text-slate-400">
            <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        )}
      </button>

      {/* Top bar: distance + close */}
      <div className="pt-safe absolute inset-x-0 top-0 z-[1000] flex items-start justify-between p-3">
        <div className="rounded-xl bg-black/70 px-4 py-2 text-white shadow">
          {readOnly ? (
            <>
              {/* While drawing/editing the headline total follows the live shape:
                  everything else saved, plus the path currently being edited. */}
              <p className="text-2xl font-bold leading-tight">
                {fmtM(
                  drawing
                    ? (monthTracks || [])
                        .filter((t) => t.id !== editingId)
                        .reduce((s, t) => s + (Number(t.distanceMeters) || 0), 0) + drawDistance
                    : monthTotal
                )}
              </p>
              <p className="text-[11px] text-white/70">
                {drawing
                  ? `${editingId ? 'Editing' : 'Drawing'} · this path ${fmtM(drawDistance)}`
                  : title || `${(monthTracks || []).length} ${ms ? 'rekod' : `recording${(monthTracks || []).length === 1 ? '' : 's'}`}`}
              </p>
            </>
          ) : (
            <>
              {/* Updated at 60fps by the glide loop (imperative — avoids re-rendering per frame) */}
              <p ref={distEl} className="text-2xl font-bold leading-tight">0 m</p>
              <p className="text-[11px] text-white/70">
                {rec.running ? (ms ? 'Merekod…' : 'Recording…') : (ms ? 'Rekod ini' : 'This recording')}
                {' · '}{ms ? 'bulan ini' : 'this month'} {fmtM(monthTotal)}
              </p>
              <p className={`text-[11px] font-medium ${accColor}`}>
                {accNow != null ? `GPS ±${Math.round(accNow)} m` : ms ? 'Mencari GPS…' : 'Getting GPS…'}
                {rec.running && accNow != null && accNow > MAX_ACCURACY_M ? (ms ? ' · isyarat lemah' : ' — weak signal, count on hold') : ''}
              </p>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={rec.running}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-xl text-white shadow disabled:opacity-40"
          aria-label={ms ? 'Tutup peta' : 'Close map'}
        >
          ×
        </button>
      </div>

      {/* Bottom controls */}
      <div className="pb-safe absolute inset-x-0 bottom-0 z-[1000] space-y-2 p-3">
        {/* Details of the tapped track — sits just above the controls on a dark
            translucent panel, so the map (and the highlighted line) stay visible. */}
        {selected && (
          // Same flex row as the buttons below, with a hidden copy of the
          // Export button as a spacer — so the panel ends exactly where the
          // Start button ends and never runs under Export.
          <div className="flex gap-2">
            <div className="relative min-w-0 flex-1 rounded-xl bg-black/70 px-3 py-2 text-white">
              {/* Bare × pinned to the panel's top-right corner */}
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="absolute right-1.5 top-0.5 p-1 text-lg leading-none text-white/60 active:text-white"
                aria-label={ms ? 'Tutup butiran' : 'Close details'}
              >
                ×
              </button>
              {/* Job + distance share the top row; the date/time gets the full
                  panel width below so AM/PM is never cut off on a phone. */}
              <div className="flex items-center gap-2 pr-5">
                <p className="min-w-0 flex-1 truncate text-sm font-semibold">{selected.pieceRateName || (ms ? 'Kerja' : 'Work')}</p>
                <span className="shrink-0 whitespace-nowrap text-base font-bold text-amber-300">
                  {fmtM(selected.distanceMeters)}
                </span>
              </div>
              <p className="truncate text-[11px] text-white/70">
                {dateOnly(selected.endedAt || selected.startedAt, ms ? 'ms-MY' : undefined)} · {ms ? 'masa' : 'time'}:{' '}
                {timeOnly(selected.endedAt || selected.startedAt, ms ? 'ms-MY' : undefined)}
              </p>
              {/* Buttons on their own row — the date line plus two or three
                  buttons overflowed the panel on a phone. */}
              <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => setExportTarget((v) => (v === selected ? null : selected))}
                    className="rounded-md bg-white/15 px-2 py-1 text-[11px] font-medium text-white active:bg-white/25"
                  >
                    {ms ? 'Eksport' : 'Export'}
                  </button>
                  {/* Drawn paths: site + HQ admin. GPS recordings: HQ admin only. */}
                  {(selected.manual ? canDraw : canEditRecorded) && (
                    <button
                      type="button"
                      onClick={editSelected}
                      className="rounded-md bg-green-500/80 px-2 py-1 text-[11px] font-medium text-white active:bg-green-500"
                    >
                      Edit
                    </button>
                  )}
                  {canDelete && (!deletableTaskId || selected.taskId === deletableTaskId) && (
                    <button
                      type="button"
                      onClick={removeSelected}
                      disabled={saving}
                      className="rounded-md bg-red-500/80 px-2 py-1 text-[11px] font-medium text-white active:bg-red-500 disabled:opacity-50"
                    >
                      {deleteLabel}
                    </button>
                  )}
              </div>
              {/* Audit row: who drew it, or that a recording was reshaped */}
              {selected.manual ? (
                <p className="text-[11px] font-medium text-amber-300">
                  {selected.drawnBy ? `Drawn by ${selected.drawnBy}` : 'Drawn manually'}
                </p>
              ) : (
                selected.editedBy && (
                  <p className="text-[11px] font-medium text-amber-300">
                    Track edited by {selected.editedBy}
                  </p>
                )
              )}
            </div>
            {hasExport && !readOnly && (
              // Must mirror the real button's label AND classes, or the panel
              // won't line up with the Start-recording button.
              <Button
                type="button"
                variant="secondary"
                className="invisible whitespace-nowrap px-3 text-sm"
                aria-hidden
                tabIndex={-1}
              >
                {ms ? 'Eksport bulan' : 'Monthly export'}
              </Button>
            )}
          </div>
        )}
        {/* Compact, left-hugging toast so it never reaches the compass button;
            clears itself after a few seconds. */}
        {error && (
          <p className="w-fit max-w-[72%] rounded-lg bg-black/75 px-3 py-2 text-sm text-red-300">{error}</p>
        )}
        {readOnly ? (
          drawing ? (
            // HQ admin drawing a path by tapping the map
            <>
              <p className="w-fit rounded-lg bg-black/75 px-3 py-1.5 text-xs text-white">
                Tap map to add · drag dots to move · tap a dot to delete ·{' '}
                <span className="font-bold text-green-300">{fmtM(drawDistance)}</span>
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setDrawPts((p) => p.slice(0, -1))}
                  disabled={!drawPts.length || saving}
                >
                  Undo
                </Button>
                <Button type="button" variant="secondary" onClick={cancelDraw} disabled={saving}>
                  Cancel
                </Button>
                <Button type="button" full onClick={saveDrawn} disabled={drawPts.length < 2 || saving}>
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Save path'}
                </Button>
              </div>
            </>
          ) : (
            // Admin: inspect + export (drawing starts from the pen icon).
            hasExport && (
              <Button type="button" full variant="secondary" onClick={() => setExportTarget('month')}>
                {ms ? 'Eksport' : 'Export'}
              </Button>
            )
          )
        ) : idle ? (
          <div className="flex gap-2">
            <Button type="button" full onClick={start} disabled={saving || !gpsReady}>
              {saving
                ? ms ? 'Menyimpan…' : 'Saving…'
                : gpsReady
                  ? ms ? '● Mula rekod' : '● Start recording'
                  : fix?.accuracy != null
                    ? `${ms ? 'Menunggu GPS' : 'Waiting for GPS'}… ±${Math.round(fix.accuracy)} m`
                    : ms ? 'Menunggu GPS…' : 'Waiting for GPS…'}
            </Button>
            {hasExport && (
              <Button
                type="button"
                variant="secondary"
                className="whitespace-nowrap px-3 text-sm"
                onClick={() => setExportTarget((v) => (v === 'month' ? null : 'month'))}
              >
                {ms ? 'Eksport bulan' : 'Monthly export'}
              </Button>
            )}
          </div>
        ) : (
          // No pause: stopping and starting again is the same thing, and each
          // recording adds to the task total.
          <>
            {/* Blinking dot + running clock, right above the stop button */}
            <p className="flex w-fit items-center gap-2 rounded-lg bg-black/75 px-3 py-1.5 text-sm text-white">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
              <span className="font-semibold text-red-300">REC {fmtElapsed(elapsed)}</span>
            </p>
            <Button type="button" full onClick={endAndSave} disabled={saving}>
              {saving ? (ms ? 'Menyimpan…' : 'Saving…') : (ms ? '■ Tamat & simpan' : '■ End & save')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
