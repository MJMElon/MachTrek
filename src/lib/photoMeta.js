// Hybrid timestamp + GPS extraction for a photo file.
//
// Strategy (chosen with the user):
//   1. Try to read GPS + original timestamp from the photo's EXIF.
//      Gallery uploads usually keep this; it is the most trustworthy source.
//   2. If the file has no GPS, fall back to the live device GPS captured at the
//      moment the photo is added to the form.
//   3. If the file has no timestamp, fall back to "now".
// The source of each value is recorded so the admin can see how it was obtained.

import exifr from 'exifr'
import { GpsSource } from '../db/models.js'

/**
 * Read whatever GPS + time we can from the file's EXIF.
 * @returns {{time: Date|null, lat: number|null, lng: number|null, hasGps: boolean}}
 */
export async function readExif(file) {
  try {
    const data = await exifr.parse(file, {
      gps: true,
      // these tags carry the original capture time
      pick: ['DateTimeOriginal', 'CreateDate', 'ModifyDate', 'GPSLatitude', 'GPSLongitude']
    })
    if (!data) return { time: null, lat: null, lng: null, hasGps: false }

    const lat = typeof data.latitude === 'number' ? data.latitude : null
    const lng = typeof data.longitude === 'number' ? data.longitude : null
    const rawTime = data.DateTimeOriginal || data.CreateDate || data.ModifyDate || null
    const time = rawTime ? new Date(rawTime) : null
    return {
      time: isValidDate(time) ? time : null,
      lat,
      lng,
      hasGps: lat != null && lng != null
    }
  } catch {
    return { time: null, lat: null, lng: null, hasGps: false }
  }
}

/** One-shot live device position, resolves null on denial/timeout/no-support. */
export function getDevicePosition(timeoutMs = 9000) {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    )
  })
}

/**
 * Full hybrid capture for one photo file.
 *
 * `opts.time` / `opts.gps` (both default true) let a caller skip detecting the
 * timestamp and/or location — used for photos that don't drive a start/end time
 * or location (the optional 2nd start photo, the proof-of-work photo), so there
 * is no misleading time and no GPS prompt/warning for them.
 *
 * @param {File|Blob} file
 * @param {{ time?: boolean, gps?: boolean }} [opts]
 * @returns {Promise<{ capturedAt: string, gps: import('../db/models.js').GeoPoint, timeSource: string }>}
 */
export async function capturePhotoMeta(file, { time = true, gps = true } = {}) {
  const now = new Date()
  const exif = time || gps ? await readExif(file) : { time: null, lat: null, lng: null, hasGps: false }

  // Timestamp — from EXIF when detecting, otherwise just "now" (not shown).
  const capturedAt = (time && exif.time ? exif.time : now).toISOString()
  const timeSource = time ? (exif.time ? GpsSource.EXIF : GpsSource.DEVICE) : GpsSource.NONE

  // Location — EXIF first, then live device GPS, only when detecting.
  let lat = null
  let lng = null
  let gpsSource = GpsSource.NONE
  let accuracy = null
  if (gps) {
    if (exif.hasGps) {
      lat = exif.lat
      lng = exif.lng
      gpsSource = GpsSource.EXIF
    } else {
      const dev = await getDevicePosition()
      if (dev) {
        lat = dev.lat
        lng = dev.lng
        gpsSource = GpsSource.DEVICE
        accuracy = dev.accuracy
      }
    }
  }

  return { capturedAt, timeSource, gps: { lat, lng, source: gpsSource, accuracy } }
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime())
}
