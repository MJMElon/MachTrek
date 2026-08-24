import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthContext.jsx'
import { Button, Card, Field, TextInput } from '../components/ui.jsx'

// Single-screen auth flow with a few small modes.
export default function Login() {
  const { user } = useAuth()
  const [mode, setMode] = useState('home') // home | operator | siteadmin | admin | forgot

  // Already signed in on this device → skip the login screen, go straight in.
  if (user) {
    return <Navigate to={user.role === 'operator' ? '/open' : '/admin/records'} replace />
  }

  return (
    <div className="min-h-full px-5 pt-safe">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-app flex-col justify-center py-10">
        <div className="mb-8 text-center">
          <img src={`${import.meta.env.BASE_URL}logo.svg`} alt="" className="mx-auto h-16 w-16 rounded-2xl" />
          <h1 className="mt-3 text-xl font-bold text-slate-800">MachTrek</h1>
          <p className="text-sm text-slate-500">
            {mode === 'operator' ? 'Rekod kerja luar talian' : 'Record your work — even offline'}
          </p>
        </div>

        {mode === 'home' && <Home onPick={setMode} />}
        {mode === 'operator' && <OperatorLogin kind="operator" onBack={() => setMode('home')} />}
        {mode === 'siteadmin' && <OperatorLogin kind="siteadmin" onBack={() => setMode('home')} />}
        {mode === 'admin' && <AdminLogin onBack={() => setMode('home')} onForgot={() => setMode('forgot')} />}
        {mode === 'forgot' && <ForgotPassword onBack={() => setMode('admin')} />}
      </div>
    </div>
  )
}

function Home({ onPick }) {
  return (
    <div className="space-y-3">
      <Button full size="lg" onClick={() => onPick('operator')}>
        Operator
      </Button>
      <Button full size="lg" variant="secondary" onClick={() => onPick('siteadmin')}>
        Site Admin
      </Button>
      <Button full size="lg" variant="secondary" onClick={() => onPick('admin')}>
        HQ Admin
      </Button>
    </div>
  )
}

function OperatorLogin({ onBack, kind }) {
  const auth = useAuth()
  const ms = kind === 'operator'
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await auth.loginOperator({ username, pin, expect: kind })
    } catch (err) {
      const operatorErrors = {
        'Enter your username.': 'Masukkan nama pengguna.',
        'Username does not exist.': 'Nama pengguna tidak dijumpai.',
        'No PIN set yet. Ask the admin.': 'PIN belum ditetapkan. Hubungi admin.',
        'Incorrect PIN.': 'PIN salah.',
        'This is a site-admin account. Use the Site Admin login.': 'Ini akaun Admin Tapak.'
      }
      setError(ms ? operatorErrors[err.message] || 'Gagal log masuk.' : err.message)
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm font-semibold text-slate-700">
          {kind === 'siteadmin' ? 'Site admin sign in' : 'Log masuk operator'}
        </p>
        <Field label={ms ? 'Nama pengguna' : 'Username'} required>
          <TextInput
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={ms ? 'nama pengguna' : 'your username'}
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
        <Field label="PIN" required error={error}>
          {/* Full keyboard — PINs may contain letters, not just digits. */}
          <TextInput
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="••••"
            className="text-center text-2xl tracking-[0.5em]"
          />
        </Field>
        <Button full type="submit" disabled={busy || !username.trim() || pin.length < 3}>
          {busy ? (ms ? 'Menyemak…' : 'Checking…') : (ms ? 'Log masuk' : 'Sign in')}
        </Button>
        <Button type="button" variant="ghost" full onClick={onBack}>
          ← {ms ? 'Kembali' : 'Back'}
        </Button>
      </form>
    </Card>
  )
}

// HQ admin = a Supabase Auth account (email + password), shared across devices.
function AdminLogin({ onBack, onForgot }) {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await auth.loginAdmin(email, password)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm font-semibold text-slate-700">HQ admin sign in</p>
        <Field label="Email">
          <TextInput
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
        <Field label="Password" error={error}>
          <TextInput
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter HQ admin password"
          />
        </Field>
        <Button full type="submit" disabled={busy || !email.trim() || !password}>
          {busy ? 'Checking…' : 'Sign in as HQ admin'}
        </Button>
        <div className="flex items-center justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            ← Back
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onForgot}>
            Forgot password?
          </Button>
        </div>
      </form>
    </Card>
  )
}

function ForgotPassword({ onBack }) {
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await auth.sendAdminReset(email)
      setSent(true)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  if (sent) {
    return (
      <Card className="p-4 text-center">
        <p className="text-sm text-slate-600">
          If that email has an HQ admin account, a password-reset link is on its way (check spam). You can also reset it
          from the Supabase dashboard → Authentication → Users.
        </p>
        <Button full className="mt-4" onClick={onBack}>
          ← Back to sign in
        </Button>
      </Card>
    )
  }

  return (
    <Card className="p-4">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">Enter the HQ admin email to receive a password-reset link.</p>
        <Field label="Email" error={error}>
          <TextInput
            type="email"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@example.com"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </Field>
        <Button full type="submit" disabled={busy || !email.trim()}>
          {busy ? 'Sending…' : 'Send reset link'}
        </Button>
        <Button type="button" variant="ghost" full onClick={onBack}>
          ← Back
        </Button>
      </form>
    </Card>
  )
}
