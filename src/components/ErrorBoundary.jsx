import { Component } from 'react'

// Catches render/runtime errors anywhere in the tree and shows a recovery
// screen instead of a blank white page.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('App error caught by boundary:', error, info)
  }

  reload = () => window.location.reload()

  logoutReload = () => {
    try {
      localStorage.removeItem('mpr.session')
    } catch {
      /* ignore */
    }
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center bg-slate-50 px-6 text-center">
        <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-bold text-slate-800">Something went wrong</h1>
          <p className="mt-2 text-sm text-slate-500">
            The app hit an unexpected error. Reloading usually fixes it. If not, log out and reload.
          </p>
          <pre className="mt-3 max-h-28 overflow-auto rounded-lg bg-slate-50 p-2 text-left text-[11px] text-slate-500">
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            onClick={this.reload}
            className="mt-4 h-12 w-full rounded-xl bg-brand font-medium text-white active:bg-brand-dark"
          >
            Reload
          </button>
          <button
            onClick={this.logoutReload}
            className="mt-2 h-12 w-full rounded-xl border border-slate-300 bg-white font-medium text-slate-700 active:bg-slate-100"
          >
            Log out &amp; reload
          </button>
        </div>
      </div>
    )
  }
}
