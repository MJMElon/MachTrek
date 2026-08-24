// Tiny pub/sub so the data layer can announce "something changed" without
// importing the sync engine (which would create an import cycle). The sync
// engine subscribes and debounces a push.
const listeners = new Set()

export function onChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function emitChange() {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* a bad listener must not break a save */
    }
  }
}
