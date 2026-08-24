// Downscale + re-encode a captured photo so the upload to Supabase stays small.
// The photo is proof of work (legible at phone size), so we target a small file
// rather than full resolution.
//
// IMPORTANT: EXIF (GPS/time) is read from the ORIGINAL file first
// (see photoMeta.js) — canvas re-encoding strips metadata.

const MAX_EDGE = 1280 // longest side in px (proof photos don't need more)
const TARGET_BYTES = 300 * 1024 // aim for <= ~300 KB per photo
const START_QUALITY = 0.8
const MIN_QUALITY = 0.4
const MIN_EDGE = 640

/**
 * @param {File|Blob} file
 * @returns {Promise<Blob>} a small JPEG (falls back to the original on failure)
 */
export async function compressImage(file) {
  try {
    const bitmap = await loadBitmap(file)

    let edge = MAX_EDGE
    let quality = START_QUALITY
    let blob = await encode(bitmap, edge, quality)

    // 1) Lower JPEG quality until under the target size.
    while (blob && blob.size > TARGET_BYTES && quality > MIN_QUALITY) {
      quality = Math.round((quality - 0.1) * 100) / 100
      blob = await encode(bitmap, edge, quality)
    }
    // 2) Still too big — shrink the dimensions and retry.
    while (blob && blob.size > TARGET_BYTES && edge > MIN_EDGE) {
      edge = Math.round(edge * 0.8)
      blob = await encode(bitmap, edge, Math.max(quality, 0.6))
    }

    if (bitmap.close) bitmap.close()

    if (!blob || blob.size === 0) return file
    // Never upload something bigger than the original.
    return file.size && blob.size >= file.size ? file : blob
  } catch {
    return file
  }
}

/**
 * Burn a black banner row onto the BOTTOM of a photo with the capture
 * date-time and GPS, so the evidence carries its own metadata even as a bare
 * image file. The banner is appended below the image (canvas grows taller),
 * never drawn over it — meter readings often sit at the photo's edge.
 * Falls back to the untouched blob on any failure.
 *
 * @param {Blob} blob - the (already compressed) JPEG
 * @param {{capturedAt?: string, gps?: {lat: number|null, lng: number|null}}} meta
 * @returns {Promise<Blob>}
 */
export async function stampPhoto(blob, { capturedAt, gps } = {}) {
  try {
    const parts = []
    if (capturedAt) parts.push(stampTime(capturedAt))
    if (gps?.lat != null && gps?.lng != null) {
      parts.push(`${Number(gps.lat).toFixed(5)}, ${Number(gps.lng).toFixed(5)}`)
    }
    const text = parts.join('   ')
    if (!text) return blob

    const bitmap = await loadBitmap(blob)
    const w = bitmap.width
    const h = bitmap.height
    const bar = Math.max(22, Math.round(w * 0.055))
    const canvas = makeCanvas(w, h + bar)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, h, w, bar)

    // Shrink the font until the line fits the banner width.
    let size = Math.round(bar * 0.5)
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    do {
      ctx.font = `${size}px system-ui, -apple-system, sans-serif`
      if (ctx.measureText(text).width <= w - bar * 0.6) break
      size--
    } while (size > 8)
    ctx.fillText(text, w / 2, h + bar / 2 + 1)

    if (bitmap.close) bitmap.close()
    const out = await toBlob(canvas, 0.8)
    return out && out.size ? out : blob
  } catch {
    return blob
  }
}

// "24/08/2026 14:03:21" — local time, unambiguous day-first order.
function stampTime(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function encode(bitmap, maxEdge, quality) {
  const { width, height } = fit(bitmap.width, bitmap.height, maxEdge)
  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(bitmap, 0, 0, width, height)
  return toBlob(canvas, quality)
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function fit(w, h, maxEdge) {
  if (w <= maxEdge && h <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / Math.max(w, h)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    return await createImageBitmap(file)
  }
  // Fallback: an <img> element is drawable and exposes width/height once decoded.
  const url = URL.createObjectURL(file)
  const img = await new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = rej
    i.src = url
  })
  URL.revokeObjectURL(url)
  img.width = img.naturalWidth
  img.height = img.naturalHeight
  return img
}

async function toBlob(canvas, quality) {
  if (canvas.convertToBlob) return await canvas.convertToBlob({ type: 'image/jpeg', quality })
  return await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality))
}
