// Parse an uploaded KML or GPX file into simple map shapes.
//
// Used for company boundaries: an admin uploads the estate/site outline once
// and every map in the app (operator recorder, admin viewers) draws it as a
// background layer for that company.
//
// Output shape (kept deliberately small — it is stored on the company row and
// synced to every device):
//   { name, features: [{ type: 'polygon' | 'line', coords: [[lat, lng], ...] }] }

const MAX_POINTS = 60000 // hard cap across the whole file, keeps the row sane

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** "lon,lat,alt lon,lat ..." (KML order) -> [[lat, lng], ...] */
function parseKmlCoords(text) {
  const out = []
  for (const chunk of String(text || '').trim().split(/\s+/)) {
    if (!chunk) continue
    const [lng, lat] = chunk.split(',')
    const la = num(lat)
    const ln = num(lng)
    if (la != null && ln != null) out.push([la, ln])
  }
  return out
}

const sameSpot = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7

function parseKML(doc) {
  const features = []
  // Polygons: use the outer ring only (holes add complexity we don't need).
  for (const poly of doc.getElementsByTagName('Polygon')) {
    const ring = poly.getElementsByTagName('LinearRing')[0]
    const c = ring && parseKmlCoords(ring.getElementsByTagName('coordinates')[0]?.textContent)
    if (c && c.length > 2) features.push({ type: 'polygon', coords: c })
  }
  for (const ls of doc.getElementsByTagName('LineString')) {
    const c = parseKmlCoords(ls.getElementsByTagName('coordinates')[0]?.textContent)
    if (c.length > 1) features.push({ type: sameSpot(c[0], c[c.length - 1]) && c.length > 3 ? 'polygon' : 'line', coords: c })
  }
  const name = doc.getElementsByTagName('name')[0]?.textContent?.trim() || ''
  return { name, features }
}

function ptsFrom(nodes) {
  const out = []
  for (const p of nodes) {
    const la = num(p.getAttribute('lat'))
    const ln = num(p.getAttribute('lon'))
    if (la != null && ln != null) out.push([la, ln])
  }
  return out
}

function parseGPX(doc) {
  const features = []
  const push = (c) => {
    if (c.length > 1) features.push({ type: sameSpot(c[0], c[c.length - 1]) && c.length > 3 ? 'polygon' : 'line', coords: c })
  }
  for (const seg of doc.getElementsByTagName('trkseg')) push(ptsFrom(seg.getElementsByTagName('trkpt')))
  for (const rte of doc.getElementsByTagName('rte')) push(ptsFrom(rte.getElementsByTagName('rtept')))
  const name = doc.getElementsByTagName('name')[0]?.textContent?.trim() || ''
  return { name, features }
}

/**
 * Parse KML or GPX text (format detected from the filename or the markup).
 * Throws with a human-readable message when nothing usable is found.
 */
export function parseGeoFile(text, filename = '') {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('That file could not be read as KML or GPX.')
  const isGpx = /\.gpx$/i.test(filename) || doc.documentElement?.nodeName?.toLowerCase() === 'gpx'
  const parsed = isGpx ? parseGPX(doc) : parseKML(doc)
  if (!parsed.features.length) throw new Error('No lines or areas found in that file.')

  // Cap the total size so a huge survey file can't bloat every device's sync.
  let budget = MAX_POINTS
  const features = []
  for (const f of parsed.features) {
    if (budget <= 0) break
    features.push(f.coords.length > budget ? { ...f, coords: f.coords.slice(0, budget) } : f)
    budget -= f.coords.length
  }
  return { name: parsed.name, features, truncated: budget <= 0 }
}

/** Total coordinate count — shown to the admin after an upload. */
export function countPoints(boundary) {
  return (boundary?.features || []).reduce((s, f) => s + (f.coords?.length || 0), 0)
}
