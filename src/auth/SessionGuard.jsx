import { useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/database.js'
import { useAuth } from './AuthContext.jsx'

/**
 * Watches the logged-in operator's record (live, so it reacts to synced admin
 * changes) and signs them out if they are deleted, deactivated, or the admin
 * forced a re-login (e.g. after changing their username/PIN).
 * Renders nothing.
 */
export function SessionGuard() {
  const { user, logout } = useAuth()

  const isOperatorAccount = user?.role === 'operator' || user?.role === 'siteadmin'

  // Returns: undefined = not applicable / still loading (do nothing);
  //          an object = the operator record; null = record genuinely missing.
  // We tag the result with the id it was fetched for so a stale value from a
  // previous state (e.g. just before login) can't trigger a false logout.
  const result = useLiveQuery(async () => {
    if (!isOperatorAccount || !user.operatorId) return undefined
    const rec = await db.operators.get(user.operatorId)
    return { forId: user.operatorId, op: rec ?? null }
  }, [user?.operatorId, user?.role])

  useEffect(() => {
    if (!isOperatorAccount) return
    if (!result || result.forId !== user.operatorId) return // loading or stale
    const op = result.op
    if (op === null) {
      logout()
      return
    } // operator deleted
    if (!op.active) {
      logout()
      return
    } // deactivated
    if (op.forceLogoutAt && user.loginAt && op.forceLogoutAt > user.loginAt) {
      logout() // admin forced re-login
    }
  }, [result, user, logout, isOperatorAccount])

  return null
}
