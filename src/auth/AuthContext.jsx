import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { db } from '../db/database.js'
import { Role } from '../db/models.js'
import { normalizePin, pinHashCandidates } from '../lib/crypto.js'
import { supabase, supabaseEnabled } from '../sync/supabase.js'

// Operator / site-admin sessions are local (offline-first). The HQ admin is a
// real Supabase Auth account, so one email + password works on every device.
const SESSION_KEY = 'mpr.session'
const AuthContext = createContext(null)

// Build the HQ-admin user object from a Supabase Auth session.
const adminFrom = (session) =>
  session?.user ? { role: Role.ADMIN, name: 'Admin', email: session.user.email || '' } : null

export function AuthProvider({ children }) {
  const [adminUser, setAdminUser] = useState(null) // from Supabase Auth
  const [opUser, setOpUser] = useState(null) // from a local operator/site-admin session
  const [ready, setReady] = useState(false)
  // Last operator selection on this device (to prefill the login form).
  const [lastOperator] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('mpr.lastOperator') || 'null')
    } catch {
      return null
    }
  })

  const user = adminUser || opUser // HQ admin takes precedence if both exist

  // Restore a local operator/site-admin session once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SESSION_KEY)
      if (raw) {
        const u = JSON.parse(raw)
        if ((u?.role === Role.OPERATOR || u?.role === Role.SITEADMIN) && u.operatorId) setOpUser(u)
        else localStorage.removeItem(SESSION_KEY)
      }
    } catch {
      /* ignore corrupt session */
    }
  }, [])

  // Track the HQ-admin Supabase Auth session (restore on load + live updates).
  useEffect(() => {
    if (!supabaseEnabled) {
      setReady(true)
      return
    }
    let active = true
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (!active) return
        setAdminUser(adminFrom(data?.session))
        setReady(true)
      })
      .catch(() => active && setReady(true))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAdminUser(adminFrom(session))
    })
    return () => {
      active = false
      sub?.subscription?.unsubscribe?.()
    }
  }, [])

  const persistOp = useCallback((u) => {
    setOpUser(u)
    try {
      if (u) localStorage.setItem(SESSION_KEY, JSON.stringify(u))
      else localStorage.removeItem(SESSION_KEY)
    } catch {
      /* private mode: in-memory only */
    }
  }, [])

  // HQ admin: a real Supabase Auth account (email + password). It's a server
  // sign-in, so it needs a connection; the session then persists + auto-refreshes.
  const loginAdmin = useCallback(async (email, password) => {
    if (!supabaseEnabled) throw new Error('HQ admin needs an internet connection to sign in.')
    const { error } = await supabase.auth.signInWithPassword({
      email: (email || '').trim().toLowerCase(),
      password
    })
    if (error) throw new Error(/invalid/i.test(error.message || '') ? 'Wrong email or password.' : error.message)
    // onAuthStateChange sets the admin user.
  }, [])

  // Operator login: PIN only (the PIN identifies the operator, so PINs must be
  // unique — Settings enforces that). Site-admin login: username + PIN. Both
  // are fully local.
  const loginOperator = useCallback(
    async ({ username, pin, expect }) => {
      const all = await db.operators.toArray()
      // PINs match case-insensitively. The hash covers new-style (lowercased)
      // and as-typed entries; the stored plain PIN covers records whose hash
      // predates the case-insensitive rule (e.g. legacy "Ab12" vs typed "ab12").
      const pinHashes = await pinHashCandidates(pin)
      const pinMatches = (o) =>
        pinHashes.includes(o.pinHash) || (o.pin && normalizePin(o.pin) === normalizePin(pin))
      let op
      if (expect === 'operator') {
        // Match the PIN against every active operator (site admins use their
        // own login, so they are excluded from the PIN-only lookup).
        const matches = all.filter((o) => o.active && !o.isSiteAdmin && pinMatches(o))
        if (matches.length > 1) throw new Error('This PIN is used by more than one operator. Ask the admin.')
        op = matches[0]
        if (!op) throw new Error('Incorrect PIN.')
      } else {
        const uname = (username || '').trim().toLowerCase()
        if (!uname) throw new Error('Enter your username.')
        op = all.find((o) => o.active && (o.name || '').trim().toLowerCase() === uname)
        // Check the username first, then the PIN.
        if (!op) throw new Error('Username does not exist.')
        if (!op.pinHash) throw new Error('No PIN set yet. Ask the admin.')
        if (!pinMatches(op)) throw new Error('Incorrect PIN.')
        if (!op.isSiteAdmin) throw new Error('This is not a site-admin account. Use the Operator login.')
      }
      const company = op.companyId ? await db.companies.get(op.companyId) : null
      persistOp({
        role: op.isSiteAdmin ? Role.SITEADMIN : Role.OPERATOR,
        operatorId: op.id,
        operatorName: op.name,
        companyId: op.companyId || null,
        companyName: company?.name || '',
        name: op.name, // shown in the top bar
        loginAt: new Date().toISOString() // used by the force-logout check
      })
    },
    [persistOp]
  )

  // Change the signed-in HQ admin's password (Supabase Auth — applies everywhere).
  const changeAdminPassword = useCallback(async (newPassword) => {
    if (!supabaseEnabled) throw new Error('Connect to the internet to change the password.')
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    if (error) throw new Error(error.message)
  }, [])

  // Email the HQ admin a password-reset link (Supabase Auth).
  const sendAdminReset = useCallback(async (email) => {
    if (!supabaseEnabled) throw new Error('Connect to the internet to reset the password.')
    const { error } = await supabase.auth.resetPasswordForEmail((email || '').trim().toLowerCase(), {
      redirectTo: window.location.origin + import.meta.env.BASE_URL
    })
    if (error) throw new Error(error.message)
  }, [])

  // Re-check the signed-in admin's password (used to confirm destructive actions).
  const verifyAdminPassword = useCallback(
    async (password) => {
      if (!supabaseEnabled || !adminUser?.email) return false
      const { error } = await supabase.auth.signInWithPassword({ email: adminUser.email, password })
      return !error
    },
    [adminUser]
  )

  const logout = useCallback(async () => {
    if (adminUser && supabaseEnabled) {
      try {
        await supabase.auth.signOut()
      } catch {
        /* ignore */
      }
      setAdminUser(null)
    }
    if (opUser) persistOp(null)
  }, [adminUser, opUser, persistOp])

  const value = {
    user,
    ready,
    lastOperator,
    isAdmin: user?.role === Role.ADMIN,
    isSiteAdmin: user?.role === Role.SITEADMIN,
    isOperator: user?.role === Role.OPERATOR,
    loginAdmin,
    loginOperator,
    changeAdminPassword,
    sendAdminReset,
    verifyAdminPassword,
    logout
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
