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
