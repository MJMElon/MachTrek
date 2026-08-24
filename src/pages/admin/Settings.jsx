import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useAuth } from '../../auth/AuthContext.jsx'
import { getMeta } from '../../db/database.js'
import { formatMoney, formatRate } from '../../lib/format.js'
import { parseGeoFile, countPoints } from '../../lib/geofile.js'
import { isDistanceUnit } from '../../lib/dashboard.js'
import {
  listPieceRates,
  upsertPieceRate,
  deletePieceRate,
  listAreas,
  upsertArea,
  deleteArea,
  listCompanies,
  getCompany,
  upsertCompany,
  deleteCompany,
  listMachines,
  getMachine,
  upsertMachine,
  deleteMachine,
  listOperators,
  upsertOperator,
  setOperatorPin,
  deleteOperator
} from '../../db/repo.js'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Card, Field, TextInput, NumberInput, Select, Modal, Badge, Spinner } from '../../components/ui.jsx'
import { IconPlus, IconTrash, IconChevron } from '../../components/icons.jsx'

const CURRENCY = 'RM'

// Quick-pick units for piece rates. "m" is the one the dashboard treats as
// Road & Drain works; the rest each get their own speed chart. The field stays
// free-text, so any other custom unit can still be typed.
const UNIT_PRESETS = ['m', 'm²', 'ton', 'trip', 'pcs']
const normUnit = (s) => String(s ?? '').trim().toLowerCase()
const editorKey = (editing) => (editing === 'new' ? 'new' : editing?.id || 'closed')

// Drill-down: Settings home -> Company -> Machine.
export default function Settings() {
  const [companyId, setCompanyId] = useState(null)
  const [machineId, setMachineId] = useState(null)

  if (companyId && machineId) {
    return <MachineDetail companyId={companyId} machineId={machineId} onBack={() => setMachineId(null)} />
  }
  if (companyId) {
    return <CompanyDetail companyId={companyId} onBack={() => setCompanyId(null)} onOpenMachine={setMachineId} />
  }
  return (
    <SettingsHome
      onOpenCompany={(id) => {
        setCompanyId(id)
        setMachineId(null)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Reusable row
// ---------------------------------------------------------------------------

function ListRow({ onClick, title, subtitle, dim }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-lg border border-slate-200 px-3 py-2.5 text-left active:bg-slate-50"
    >
      <div className="min-w-0">
        <p className={`truncate font-medium ${dim ? 'text-slate-500' : 'text-slate-800'}`}>{title}</p>
        {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
      </div>
      <IconChevron width={16} height={16} className="shrink-0 text-slate-300" />
    </button>
  )
}

function SectionCard({ title, count, onAdd, addLabel, children }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold text-slate-800">
          {title} {count != null && <span className="text-sm font-normal text-slate-500">{count}</span>}
        </h2>
      </div>
      <div className="space-y-2">{children}</div>
      {onAdd && (
        <Button variant="secondary" full className="mt-3" onClick={onAdd}>
          <IconPlus width={18} height={18} /> {addLabel}
        </Button>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Level 0 — Settings home (Companies + Security + About)
// ---------------------------------------------------------------------------

function SettingsHome({ onOpenCompany }) {
  const companies = useLiveQuery(() => listCompanies({ includeInactive: true }), [], [])
  const [editing, setEditing] = useState(null)

  return (
    <div className="space-y-4 pb-6">
      <h1 className="text-lg font-bold text-slate-800">Settings</h1>

      <SectionCard
        title="Companies"
        count={companies?.length}
        onAdd={() => setEditing('new')}
        addLabel="Add company"
      >
        {(companies || []).map((c) => (
          <ListRow
            key={c.id}
            title={c.name}
            subtitle="Operators, machines & areas"
            dim={!c.active}
            onClick={() => onOpenCompany(c.id)}
          />
        ))}
        {companies && companies.length === 0 && (
          <p className="text-sm text-slate-500">No companies yet. Add one to begin.</p>
        )}
      </SectionCard>

      <SecuritySection />
      <AboutSection />

      <CompanyEditor key={editorKey(editing)} editing={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Level 1 — a company (its Operators, Machines, Areas)
// ---------------------------------------------------------------------------

function CompanyDetail({ companyId, onBack, onOpenMachine }) {
  const company = useLiveQuery(async () => (await getCompany(companyId)) ?? null, [companyId])
  const machines = useLiveQuery(() => listMachines({ companyId, includeInactive: true }), [companyId], [])
  const operatorsAll = useLiveQuery(() => listOperators({ includeInactive: true }), [], [])
  const areas = useLiveQuery(() => listAreas({ companyId, includeInactive: true }), [companyId], [])
  const operators = (operatorsAll || []).filter((o) => o.companyId === companyId)

  const [editCompany, setEditCompany] = useState(false)
  const [machineEditing, setMachineEditing] = useState(null)
  const [operatorEditing, setOperatorEditing] = useState(null)
  const [areaEditing, setAreaEditing] = useState(null)

  if (company === undefined) {
    return (
      <div className="flex justify-center py-20 text-brand">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (company === null) {
    onBack()
    return null
  }

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title={company.name}
        subtitle="Company settings"
        onBack={onBack}
        right={
          <Button size="sm" variant="ghost" onClick={() => setEditCompany(true)}>
            Edit
          </Button>
        }
      />

      <SectionCard
        title="Operators"
        count={operators.length}
        onAdd={() => setOperatorEditing('new')}
        addLabel="Add operator"
      >
        {operators.map((o) => {
          const n = o.machineIds?.length || 0
          return (
            <ListRow
              key={o.id}
              title={o.name}
              dim={!o.active}
              subtitle={`${o.isSiteAdmin ? 'Site admin · ' : ''}${o.pinHash ? 'PIN set' : 'no PIN'} · ${n} machine${n === 1 ? '' : 's'}${o.active ? '' : ' · inactive'}`}
              onClick={() => setOperatorEditing(o)}
            />
          )
        })}
        {operators.length === 0 && <p className="text-sm text-slate-500">No operators in this company.</p>}
      </SectionCard>

      <SectionCard
        title="Machines"
        count={machines?.length}
        onAdd={() => setMachineEditing('new')}
        addLabel="Add machine"
      >
        {(machines || []).map((m) => (
          <ListRow
            key={m.id}
            title={m.name}
            dim={!m.active}
            subtitle={`Tap to set piece rates${m.active ? '' : ' · inactive'}`}
            onClick={() => onOpenMachine(m.id)}
          />
        ))}
        {machines && machines.length === 0 && (
          <p className="text-sm text-slate-500">No machines in this company.</p>
        )}
      </SectionCard>

      <SectionCard
        title="Areas"
        count={areas?.length}
        onAdd={() => setAreaEditing('new')}
        addLabel="Add area"
      >
        {(areas || []).map((a) => (
          <ListRow key={a.id} title={a.name} dim={!a.active} onClick={() => setAreaEditing(a)} />
        ))}
        {areas && areas.length === 0 && <p className="text-sm text-slate-500">No areas in this company.</p>}
      </SectionCard>

      <BoundarySection company={company} />

      <CompanyEditor
        key={editCompany ? 'edit' : 'closed'}
        editing={editCompany ? company : null}
        onClose={() => setEditCompany(false)}
        onDeleted={onBack}
      />
      <MachineEditor
        key={editorKey(machineEditing)}
        editing={machineEditing}
        companyId={companyId}
        onClose={() => setMachineEditing(null)}
      />
      <OperatorEditor
        key={editorKey(operatorEditing)}
        editing={operatorEditing}
        companyId={companyId}
        machines={machines || []}
        onClose={() => setOperatorEditing(null)}
      />
      <AreaEditor
        key={editorKey(areaEditing)}
        editing={areaEditing}
        companyId={companyId}
        onClose={() => setAreaEditing(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Company boundary — a KML/GPX site outline shown on every map for the company
// ---------------------------------------------------------------------------

function BoundarySection({ company }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const boundary = company?.boundary || null
  const shapes = boundary?.features?.length || 0

  async function onFile(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr('')
    setMsg('')
    setBusy(true)
    try {
      const parsed = parseGeoFile(await file.text(), file.name)
      await upsertCompany({ ...company, boundary: { ...parsed, fileName: file.name } })
      setMsg(
        `Loaded ${parsed.features.length} shape${parsed.features.length === 1 ? '' : 's'}` +
          (parsed.truncated ? ' (file was very large — trimmed)' : '')
      )
    } catch (e2) {
      setErr(e2.message || 'Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  async function clear() {
    if (!window.confirm('Remove this boundary from all maps for this company?')) return
    setErr('')
    setMsg('')
    await upsertCompany({ ...company, boundary: null })
  }

  return (
    <Card className="p-4">
      <h2 className="font-semibold text-slate-800">Boundary</h2>
      <p className="mb-2 mt-0.5 text-xs text-slate-500">
        Upload a KML or GPX outline of this company’s site. It shows on every map — for operators and
        admins — behind the recorded paths. After a device syncs it once, the boundary stays available
        on that device offline.
      </p>

      <input ref={fileRef} type="file" accept=".kml,.gpx,application/vnd.google-earth.kml+xml,application/gpx+xml,text/xml" hidden onChange={onFile} />

      {boundary ? (
        <div className="rounded-lg border border-slate-200 px-3 py-2">
          <p className="truncate text-sm font-medium text-slate-800">{boundary.fileName || boundary.name || 'Boundary'}</p>
          <p className="text-xs text-slate-500">
            {shapes} shape{shapes === 1 ? '' : 's'} · {countPoints(boundary).toLocaleString()} points
          </p>
        </div>
      ) : (
        <p className="text-sm text-slate-500">No boundary uploaded.</p>
      )}

      {err && <p className="mt-2 text-xs text-red-500">{err}</p>}
      {msg && <p className="mt-2 text-xs text-green-600">{msg}</p>}

      <div className="mt-3 flex gap-2">
        <Button variant="secondary" full onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? 'Reading…' : boundary ? 'Replace file' : 'Upload KML / GPX'}
        </Button>
        {boundary && (
          <Button variant="danger" onClick={clear} disabled={busy}>
            <IconTrash width={16} height={16} />
          </Button>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// Level 2 — a machine (its piece rates)
// ---------------------------------------------------------------------------

function MachineDetail({ companyId, machineId, onBack }) {
  const machine = useLiveQuery(async () => (await getMachine(machineId)) ?? null, [machineId])
  const rates = useLiveQuery(() => listPieceRates({ machineId, includeInactive: true }), [machineId], [])
  const [editMachine, setEditMachine] = useState(false)
  const [rateEditing, setRateEditing] = useState(null)

  if (machine === undefined) {
    return (
      <div className="flex justify-center py-20 text-brand">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (machine === null) {
    onBack()
    return null
  }

  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title={machine.name}
        subtitle="Machine · piece rates"
        onBack={onBack}
        right={
          <Button size="sm" variant="ghost" onClick={() => setEditMachine(true)}>
            Edit
          </Button>
        }
      />

      <SectionCard
        title="Piece rates"
        count={rates?.length}
        onAdd={() => setRateEditing('new')}
        addLabel="Add piece rate"
      >
        {(rates || []).map((r) => (
          <ListRow
            key={r.id}
            title={r.name}
            dim={!r.active}
            subtitle={`${formatRate(r.price, CURRENCY)} / ${r.unit}${r.active ? '' : ' · hidden'}`}
            onClick={() => setRateEditing(r)}
          />
        ))}
        {rates && rates.length === 0 && <p className="text-sm text-slate-500">No piece rates yet.</p>}
      </SectionCard>

      <MachineEditor
        key={editMachine ? 'edit' : 'closed'}
        editing={editMachine ? machine : null}
        companyId={companyId}
        onClose={() => setEditMachine(false)}
        onDeleted={onBack}
      />
      <RateEditor
        key={editorKey(rateEditing)}
        editing={rateEditing}
        machineId={machineId}
        onClose={() => setRateEditing(null)}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editors
// ---------------------------------------------------------------------------

function CompanyEditor({ editing, onClose, onDeleted }) {
  const { verifyAdminPassword } = useAuth()
  const isNew = editing === 'new'
  const item = isNew ? null : editing
  const open = editing != null
  const [name, setName] = useState(item?.name || '')
  const [active, setActive] = useState(item?.active !== false)
  const [error, setError] = useState('')
  // Deleting a company removes ALL its data, so it's gated behind the admin password.
  const [confirming, setConfirming] = useState(false)
  const [pw, setPw] = useState('')
  const [delErr, setDelErr] = useState('')
  const [busy, setBusy] = useState(false)

  async function save() {
    if (!name.trim()) return setError('Enter a company name.')
    await upsertCompany({ id: item?.id, name, active })
    onClose()
  }
  async function confirmDelete() {
    setDelErr('')
    if (!pw) return setDelErr('Enter your HQ admin password.')
    setBusy(true)
    try {
      if (!(await verifyAdminPassword(pw))) {
        setDelErr('Wrong password.')
        setBusy(false)
        return
      }
      await deleteCompany(item.id)
      onClose()
      onDeleted?.()
    } catch (e) {
      setDelErr(e.message || 'Could not delete.')
      setBusy(false)
    }
  }
  function cancelDelete() {
    setConfirming(false)
    setPw('')
    setDelErr('')
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'New company' : confirming ? 'Delete company' : 'Edit company'}>
      {confirming ? (
        <div className="space-y-3">
          <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm">
            <p className="font-semibold text-red-700">Permanently delete “{item.name}” and everything in it?</p>
            <p className="mt-1 text-red-600">
              This removes its machines, piece rates, operators, areas, and all work records + photos — on every device
              and in the cloud. This cannot be undone.
            </p>
          </div>
          <Field label="Type your HQ admin password to confirm" error={delErr}>
            <TextInput
              type="password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="HQ admin password"
              autoFocus
            />
          </Field>
          <Button full variant="danger" onClick={confirmDelete} disabled={busy}>
            {busy ? 'Deleting…' : 'Permanently delete company'}
          </Button>
          <Button full variant="secondary" onClick={cancelDelete} disabled={busy}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Company name" required error={error}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ABC Construction" autoFocus />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
          <Button full onClick={save}>
            Save
          </Button>
          {!isNew && (
            <Button full variant="danger" onClick={() => setConfirming(true)}>
              <IconTrash width={16} height={16} /> Delete
            </Button>
          )}
        </div>
      )}
    </Modal>
  )
}

function MachineEditor({ editing, companyId, onClose, onDeleted }) {
  const isNew = editing === 'new'
  const item = isNew ? null : editing
  const open = editing != null
  const [name, setName] = useState(item?.name || '')
  const [active, setActive] = useState(item?.active !== false)
  const [error, setError] = useState('')

  async function save() {
    if (!name.trim()) return setError('Enter a machine name.')
    await upsertMachine({ id: item?.id, companyId, name, active })
    onClose()
  }
  async function remove() {
    if (!confirm(`Delete machine "${item.name}"? Its records stay in the system.`)) return
    await deleteMachine(item.id)
    onClose()
    onDeleted?.()
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'New machine' : 'Edit machine'}>
      <div className="space-y-3">
        <Field label="Machine name" required error={error}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Excavator EX-01" autoFocus />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <Button full onClick={save}>
          Save
        </Button>
        {!isNew && (
          <Button full variant="danger" onClick={remove}>
            <IconTrash width={16} height={16} /> Delete
          </Button>
        )}
      </div>
    </Modal>
  )
}

function OperatorEditor({ editing, companyId, machines, onClose }) {
  const isNew = editing === 'new'
  const item = isNew ? null : editing
  const open = editing != null
  const [name, setName] = useState(item?.name || '')
  const [active, setActive] = useState(item?.active !== false)
  const [pin, setPin] = useState(item?.pin || '')
  const [showPin, setShowPin] = useState(false)
  const [machineIds, setMachineIds] = useState(item?.machineIds || [])
  const [isSiteAdmin, setIsSiteAdmin] = useState(item?.isSiteAdmin === true)
  const [basicSalary, setBasicSalary] = useState(item?.basicSalary ?? '')
  const [phoneAllowance, setPhoneAllowance] = useState(item?.phoneAllowance ?? '')
  const [hourlyRate, setHourlyRate] = useState(item?.hourlyRate ?? '')
  const [forceLogout, setForceLogout] = useState(false)
  const [error, setError] = useState('')

  const toggleMachine = (id) =>
    setMachineIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  async function save() {
    if (!name.trim()) return setError('Enter a username.')
    if (pin && pin.length < 4) return setError('PIN must be at least 4 digits.')
    if (isNew && !pin) return setError('Set a PIN so the operator can log in.')
    try {
      const validIds = machineIds.filter((id) => machines.some((m) => m.id === id))
      const saved = await upsertOperator({
        id: item?.id,
        name,
        companyId,
        active,
        isSiteAdmin,
        basicSalary: basicSalary === '' ? null : basicSalary,
        phoneAllowance: phoneAllowance === '' ? null : phoneAllowance,
        hourlyRate: hourlyRate === '' ? null : hourlyRate,
        machineIds: validIds,
        forceLogout
      })
      if (pin) await setOperatorPin(saved.id, pin)
      onClose()
    } catch (e) {
      setError(e.message)
    }
  }
  async function remove() {
    if (!confirm(`Delete operator "${item.name}"? Their records stay in the system.`)) return
    await deleteOperator(item.id)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'New operator' : 'Edit operator'}>
      <div className="space-y-3">
        <Field label="Username" required hint="Typed at login (not case-sensitive)" error={error}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. ahmad" autoFocus autoCapitalize="none" />
        </Field>
        <label className="flex items-center gap-2 rounded-lg bg-brand-light px-2 py-2 text-sm text-brand-dark">
          <input type="checkbox" checked={isSiteAdmin} onChange={(e) => setIsSiteAdmin(e.target.checked)} />
          Site admin — can add &amp; edit this company&apos;s tasks
        </label>
        <Field label="PIN" required={isNew} hint="Operators type this to log in">
          <div className="relative">
            <TextInput
              type={showPin ? 'text' : 'password'}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••"
              className="pr-16"
            />
            <button
              type="button"
              onClick={() => setShowPin((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-brand"
            >
              {showPin ? 'Hide' : 'Show'}
            </button>
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Basic salary" hint="Gaji Bulanan in claim form">
            <NumberInput value={basicSalary} onChange={(e) => setBasicSalary(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Phone allowance" hint="Elaun telephone in claim form">
            <NumberInput value={phoneAllowance} onChange={(e) => setPhoneAllowance(e.target.value)} placeholder="0.00" />
          </Field>
        </div>
        <Field label="Kerja jam" hint="Hourly rate (RM/jam) — selectable as a piece rate + drives the dashboard comparison">
          <NumberInput value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)} placeholder="0.00" />
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Machines this operator can use</p>
          <div className="max-h-48 space-y-1 overflow-auto rounded-lg border border-slate-200 p-2">
            {machines.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={machineIds.includes(m.id)} onChange={() => toggleMachine(m.id)} />
                {m.name}
                {m.active ? '' : ' (inactive)'}
              </label>
            ))}
            {machines.length === 0 && <p className="text-xs text-slate-500">Add machines to this company first.</p>}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active (can log in)
        </label>
        {!isNew && (
          <label className="flex items-center gap-2 rounded-lg bg-amber-50 px-2 py-2 text-sm text-amber-800">
            <input type="checkbox" checked={forceLogout} onChange={(e) => setForceLogout(e.target.checked)} />
            Sign out of all devices (require re-login)
          </label>
        )}
        <Button full onClick={save}>
          Save
        </Button>
        {!isNew && (
          <Button full variant="danger" onClick={remove}>
            <IconTrash width={16} height={16} /> Delete
          </Button>
        )}
      </div>
    </Modal>
  )
}

function AreaEditor({ editing, companyId, onClose }) {
  const isNew = editing === 'new'
  const item = isNew ? null : editing
  const open = editing != null
  const [name, setName] = useState(item?.name || '')
  const [active, setActive] = useState(item?.active !== false)
  const [error, setError] = useState('')

  async function save() {
    if (!name.trim()) return setError('Enter an area name.')
    await upsertArea({ id: item?.id, companyId, name, active })
    onClose()
  }
  async function remove() {
    if (!confirm(`Delete area "${item.name}"?`)) return
    await deleteArea(item.id)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'New area' : 'Edit area'}>
      <div className="space-y-3">
        <Field label="Area name" required error={error}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Zone A" autoFocus />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Show this area to operators
        </label>
        <Button full onClick={save}>
          Save
        </Button>
        {!isNew && (
          <Button full variant="danger" onClick={remove}>
            <IconTrash width={16} height={16} /> Delete
          </Button>
        )}
      </div>
    </Modal>
  )
}

function RateEditor({ editing, machineId, onClose }) {
  const isNew = editing === 'new'
  const item = isNew ? null : editing
  const open = editing != null
  const [name, setName] = useState(item?.name || '')
  const [unit, setUnit] = useState(item?.unit || '')
  const [price, setPrice] = useState(item?.price ?? '')
  const [active, setActive] = useState(item?.active !== false)
  const [error, setError] = useState('')

  async function save() {
    if (!name.trim() || !unit.trim()) return setError('Enter a work name and unit.')
    await upsertPieceRate({ id: item?.id, machineId: item?.machineId ?? machineId, name, unit, price, active })
    onClose()
  }
  async function remove() {
    if (!confirm(`Delete piece rate "${item.name}"? Existing records keep their saved values.`)) return
    await deletePieceRate(item.id)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title={isNew ? 'New piece rate' : 'Edit piece rate'}>
      <div className="space-y-3">
        <Field label="Work name" required error={error}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Repair road" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Field label="Unit" required>
              <TextInput value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="m" />
            </Field>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {UNIT_PRESETS.map((u) => {
                const on = normUnit(unit) === u
                return (
                  <button
                    key={u}
                    type="button"
                    onClick={() => setUnit(u)}
                    className={
                      'rounded-full border px-2 py-0.5 text-xs ' +
                      (on
                        ? 'border-brand bg-brand/10 font-semibold text-brand'
                        : 'border-slate-200 text-slate-500 active:bg-slate-100')
                    }
                  >
                    {u}
                  </button>
                )
              })}
            </div>
            {normUnit(unit) && (
              <p className="mt-1 text-[11px] text-slate-500">
                {isDistanceUnit(unit)
                  ? '→ groups into “Road & Drain works” (m/jam)'
                  : `→ its own speed chart (${normUnit(unit)}/jam)`}
              </p>
            )}
          </div>
          <Field label="Price per unit" required>
            <NumberInput value={price} onChange={(e) => setPrice(e.target.value)} placeholder="25" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Show this rate to operators
        </label>
        <Button full onClick={save}>
          Save
        </Button>
        {!isNew && (
          <Button full variant="danger" onClick={remove}>
            <IconTrash width={16} height={16} /> Delete
          </Button>
        )}
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Security + About
// ---------------------------------------------------------------------------

function SecuritySection() {
  const { changeAdminPassword } = useAuth()
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [open, setOpen] = useState(false)

  async function change() {
    setErr('')
    setMsg('')
    if (pw.length < 6) return setErr('New password must be at least 6 characters.')
    if (pw !== pw2) return setErr('New passwords do not match.')
    try {
      await changeAdminPassword(pw)
      setPw('')
      setPw2('')
      setMsg('Password changed.')
    } catch (e) {
      setErr(e.message)
    }
  }

  return (
    <Card className="overflow-hidden">
      <button className="flex w-full items-center justify-between px-4 py-3 active:bg-slate-50" onClick={() => setOpen((v) => !v)}>
        <span className="font-semibold text-slate-800">Admin security</span>
        <IconChevron width={18} height={18} className={`text-slate-300 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-slate-100 p-4">
          <p className="text-sm font-medium text-slate-600">Change HQ admin password</p>
          <p className="text-xs text-slate-500">
            This is your Supabase Auth account — the new password works on every device.
          </p>
          <Field label="New password">
            <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Confirm new password" error={err}>
            <TextInput type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          {msg && <p className="text-sm text-green-600">{msg}</p>}
          <Button onClick={change}>Change password</Button>
        </div>
      )}
    </Card>
  )
}

function AboutSection() {
  const lastSyncAt = useLiveQuery(() => getMeta('lastSyncAt', null), [], null)
  return (
    <Card className="p-4">
      <p className="text-sm text-slate-500">MachTrek · v{import.meta.env.VITE_APP_VERSION}</p>
      <p className="text-sm text-slate-500">
        Last successful sync: {lastSyncAt ? new Date(lastSyncAt).toLocaleString() : 'never'}
      </p>
      <p className="mt-1 text-xs text-slate-500">Records are saved on the device first and sync automatically when online.</p>
    </Card>
  )
}
