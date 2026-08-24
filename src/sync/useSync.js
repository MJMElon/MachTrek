import { useEffect, useState } from 'react'
import { subscribeSync, getSyncState, requestSync } from './syncEngine.js'

/** React view of the sync engine's live state. */
export function useSync() {
  const [s, setS] = useState(getSyncState())
  useEffect(() => subscribeSync(setS), [])
  return { ...s, syncNow: requestSync }
}
