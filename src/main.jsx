import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
// HashRouter (URLs like /#/open) so deep links never 404 on GitHub Pages,
// which has no SPA server fallback. Invisible once installed as a PWA.
import { HashRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import { AuthProvider } from './auth/AuthContext.jsx'
import { seedIfEmpty } from './db/database.js'
import { startSync } from './sync/syncEngine.js'
import { purgeOldData, cleanupMachineHourlyRates, repairKerjaJamTasks } from './db/repo.js'

// `autoUpdate` activates a newly deployed service worker immediately. Register
// through the plugin's client helper so it also reloads this page when that new
// worker takes control; otherwise an already-open app can keep references to
// old lazy chunks (such as the map) after the old precache has been removed.
registerSW({
  onRegisterError: (error) => console.error('Service worker registration failed', error)
})

// Seed first-run defaults, remove any leftover machine-level "Kerja jam" rate
// from an earlier build, repair tasks that stored the Kerja jam sentinel id,
// purge data past the 3-year retention window, then start the background sync
// engine (which pushes the cleanup/repair/purge changes up).
seedIfEmpty()
  .catch((e) => console.error('Seed failed', e))
  .then(() => cleanupMachineHourlyRates())
  .catch((e) => console.error('Hourly-rate cleanup failed', e))
  .then(() => repairKerjaJamTasks())
  .catch((e) => console.error('Kerja jam repair failed', e))
  .then(() => purgeOldData())
  .catch((e) => console.error('Purge failed', e))
  .finally(() => startSync())

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>
)
