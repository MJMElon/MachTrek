import { Routes, Route, Navigate, Outlet } from 'react-router-dom'
import { useAuth } from './auth/AuthContext.jsx'
import Login from './auth/Login.jsx'
import { Shell } from './components/Shell.jsx'
import { Spinner } from './components/ui.jsx'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'
import { SessionGuard } from './auth/SessionGuard.jsx'

import NewTask from './pages/operator/NewTask.jsx'
import OpenTasks from './pages/operator/OpenTasks.jsx'
import CompleteTask from './pages/operator/CompleteTask.jsx'
import OperatorSummary from './pages/operator/OperatorSummary.jsx'

import AdminRecords from './pages/admin/AdminRecords.jsx'
import EditTask from './pages/admin/EditTask.jsx'
import AddTask from './pages/admin/AddTask.jsx'
import Settings from './pages/admin/Settings.jsx'
import PayrollReport from './pages/admin/PayrollReport.jsx'
import ClaimForm from './pages/admin/ClaimForm.jsx'
import AllClaims from './pages/admin/AllClaims.jsx'
import Dashboard from './pages/admin/Dashboard.jsx'
import Worklog from './pages/admin/Worklog.jsx'

export default function App() {
  const { ready, user } = useAuth()

  if (!ready) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center text-brand">
        <Spinner className="h-8 w-8" />
      </div>
    )
  }

  return (
    <ErrorBoundary>
      <SessionGuard />
      <Routes>
        <Route path="/" element={<RootRedirect />} />
      <Route path="/login" element={user ? <RootRedirect /> : <Login />} />

      {/* Operator area */}
      <Route element={<RequireRole role="operator" />}>
        <Route element={<Shell />}>
          <Route path="/open" element={<OpenTasks />} />
          <Route path="/open/new" element={<NewTask />} />
          <Route path="/open/:id" element={<CompleteTask />} />
          <Route path="/summary" element={<OperatorSummary />} />
        </Route>
      </Route>

      {/* Manager area — system admin + per-company site admin */}
      <Route element={<RequireManager />}>
        <Route element={<Shell />}>
          <Route path="/admin" element={<Navigate to="/admin/records" replace />} />
          <Route path="/admin/records" element={<AdminRecords />} />
          <Route path="/admin/task/:id" element={<EditTask />} />
          <Route path="/admin/add" element={<AddTask />} />
          <Route path="/admin/worklog/:operatorId" element={<Worklog />} />
          <Route path="/admin/payroll" element={<AdminOnly><PayrollReport /></AdminOnly>} />
          <Route path="/admin/claim/:operatorId" element={<AdminOnly><ClaimForm /></AdminOnly>} />
          <Route path="/admin/claims/:companyId" element={<AdminOnly><AllClaims /></AdminOnly>} />
          <Route path="/admin/dashboard" element={<AdminOnly><Dashboard /></AdminOnly>} />
          <Route path="/admin/settings" element={<AdminOnly><Settings /></AdminOnly>} />
        </Route>
      </Route>

        <Route path="*" element={<RootRedirect />} />
      </Routes>
    </ErrorBoundary>
  )
}

function RootRedirect() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  return <Navigate to={user.role === 'operator' ? '/open' : '/admin/records'} replace />
}

function RequireRole({ role }) {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== role) return <RootRedirect />
  return <Outlet />
}

// System admin OR a company site admin.
function RequireManager() {
  const { user } = useAuth()
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== 'admin' && user.role !== 'siteadmin') return <RootRedirect />
  return <Outlet />
}

// Settings is system-admin only.
function AdminOnly({ children }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/admin/records" replace />
  return children
}
