import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { getOperator, getCompany, getMonthTasks, setCompanySigners, getClaim, saveClaimIncentives, isMonthLocked } from '../../db/repo.js'
import { TaskStatus } from '../../db/models.js'
import { monthKeyOf, monthLabel, claimPdfName } from '../../lib/format.js'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Spinner } from '../../components/ui.jsx'
import { IconPlus, IconTrash, IconLock } from '../../components/icons.jsx'

const money = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
// Rate/unit price shows its full precision (some rates have >2 decimals); the
// subjumlah still rounds to 2. Min 2 decimals, trailing zeros trimmed after that.
const rateFmt = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 10 })
const qtyFmt = (n) => (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })
const sub = (rate, qty) => (Number(rate) || 0) * (Number(qty) || 0)
const todayStr = () => {
  const d = new Date()
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
}
const signersKey = (s) =>
  JSON.stringify({
    prepared: { name: s?.prepared?.name || '', role: s?.prepared?.role || '' },
    verifiers: (s?.verifiers || []).map((v) => ({ name: v.name || '', role: v.role || '' }))
  })

// A bordered cell input that reads as plain text when printed.
function CellInput({ className = '', ...props }) {
  return (
    <input
      className={`block w-full bg-transparent px-0 text-sm leading-tight outline-none focus:bg-brand-light/40 read-only:cursor-default read-only:focus:bg-transparent print:focus:bg-transparent ${className}`}
      {...props}
    />
  )
}

// Bahagian B (incentives) + Bahagian C (summary) are hidden for now — only
// Bahagian A is used. Flip this to true to bring them back.
const SHOW_INCENTIVES = false

export default function ClaimForm() {
  const { operatorId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const monthKey = searchParams.get('month') || monthKeyOf(new Date())

  const operator = useLiveQuery(async () => (await getOperator(operatorId)) ?? null, [operatorId])
  const company = useLiveQuery(
    async () => (operator?.companyId ? (await getCompany(operator.companyId)) ?? null : null),
    [operator?.companyId]
  )
  const tasks = useLiveQuery(() => getMonthTasks({ operatorId, monthKey }), [operatorId, monthKey], undefined)
  const savedClaim = useLiveQuery(() => getClaim(operatorId, monthKey), [operatorId, monthKey], undefined)
  const locked = useLiveQuery(() => isMonthLocked(monthKey), [monthKey], false)

  // Section A — completed piece-rate work, aggregated from tasks.
  const autoRows = useMemo(() => {
    const completed = (tasks || []).filter((t) => t.status === TaskStatus.COMPLETED)
    const map = new Map()
    for (const t of completed) {
      // Split each work type by area/location so the same work in different
      // areas shows as its own row, e.g. "Compact jalan (Phase 1)".
      const rateKey = t.pieceRateId || `name:${t.pieceRateName || 'Work'}`
      const areaKey = t.areaId || `name:${(t.areaName || '').trim().toLowerCase()}`
      const k = `${rateKey}__${areaKey}`
      if (!map.has(k)) {
        const work = t.pieceRateName || 'Work'
        const loc = (t.areaName || '').trim()
        map.set(k, { desc: loc ? `${work} (${loc})` : work, work, loc, unit: t.unit || '', rate: t.unitPrice || 0, qty: 0, amount: 0 })
      }
      const r = map.get(k)
      r.qty += Number(t.quantity) || 0
      r.amount += Number(t.amount) || 0
    }
    // Keep each work type's areas together (Phase 1, Phase 2, …).
    // Hide rows that contribute nothing — e.g. work completed without a quantity
    // (0 jumlah unit and 0 amount) — so they don't clutter the claim.
    return [...map.values()]
      .filter((r) => Number(r.qty) !== 0 || Number(r.amount) !== 0)
      .sort((a, b) => a.work.localeCompare(b.work) || a.loc.localeCompare(b.loc))
  }, [tasks])

  const machines = useMemo(() => {
    const set = new Set((tasks || []).map((t) => t.machineName).filter(Boolean))
    return [...set].join(', ')
  }, [tasks])

  // Editable extra Section A rows (monthly salary, allowances). Both are added by
  // the init effect only when the operator has that value preset in Settings, so
  // the default is empty (an admin can still add rows manually).
  const [extraA, setExtraA] = useState([])
  // Section B — incentives. Saved per operator + month (see saved-claim effect).
  const defaultIncentives = () => [{ desc: 'Insentif Audit Jalan (Bulan: )', unit: 'Setiap Kes', rate: '', qty: '' }]
  const [incentives, setIncentives] = useState(defaultIncentives)
  const [bSaving, setBSaving] = useState(false)
  const [bClean, setBClean] = useState(true) // true = matches what's saved

  // Load the saved Bahagian B for this operator + month. Re-runs if the
  // operator/month changes (the route component can be reused).
  const claimKeyRef = useRef(null)
  useEffect(() => {
    if (savedClaim === undefined) return // still loading
    const key = `${operatorId}__${monthKey}`
    if (claimKeyRef.current === key) return
    claimKeyRef.current = key
    if (savedClaim?.incentives?.length) {
      setIncentives(
        savedClaim.incentives.map((r) => ({ desc: r.desc || '', unit: r.unit || '', rate: r.rate ?? '', qty: r.qty ?? '' }))
      )
    } else {
      setIncentives(defaultIncentives())
    }
    setBClean(true)
  }, [savedClaim, operatorId, monthKey])

  const [prepared, setPrepared] = useState({ name: '', role: '', date: '' })
  const [verifiers, setVerifiers] = useState([{ name: '', role: '', date: '' }])

  // Pre-fill signers from the company's saved defaults (once), date = today.
  const initRef = useRef(false)
  useEffect(() => {
    if (initRef.current) return
    if (operator === undefined) return // operator still loading
    // Wait until the operator's actual company has loaded before reading signers
    // (otherwise we'd init from a transient null company and never load them).
    if (operator?.companyId && company?.id !== operator.companyId) return
    initRef.current = true
    const today = todayStr()
    // Pre-fill the Section A pay rows from the operator's saved pay. Each row only
    // appears when that value is preset in Settings — "Gaji Bulanan" for basic
    // salary, "Elaun telephone" for phone allowance; otherwise it's omitted (an
    // admin can still add it manually).
    const payRows = []
    if (operator?.basicSalary != null) {
      payRows.push({ desc: 'Gaji Bulanan', unit: 'Sebulan', rate: String(operator.basicSalary), qty: '1' })
    }
    if (operator?.phoneAllowance != null) {
      payRows.push({ desc: 'Elaun telephone', unit: 'Sebulan', rate: String(operator.phoneAllowance), qty: '1' })
    }
    setExtraA(payRows)
    const s = company?.signers
    if (s) {
      setPrepared({ name: s.prepared?.name || '', role: s.prepared?.role || '', date: today })
      const vs = Array.isArray(s.verifiers) && s.verifiers.length ? s.verifiers : [{ name: '', role: '' }]
      setVerifiers(vs.map((v) => ({ name: v.name || '', role: v.role || '', date: today })))
    } else {
      setPrepared((p) => ({ ...p, date: today }))
      setVerifiers((p) => p.map((v) => ({ ...v, date: today })))
    }
  }, [operator, company])

  // Remember edited names/positions on the company for next month. Debounced
  // while typing, and FLUSHED immediately when leaving the page so a quick
  // navigation can't drop the edit.
  const pendingRef = useRef(null)
  useEffect(() => {
    if (!initRef.current || !company) return
    const next = { prepared: { name: prepared.name, role: prepared.role }, verifiers: verifiers.map((v) => ({ name: v.name, role: v.role })) }
    if (signersKey(next) === signersKey(company.signers)) {
      pendingRef.current = null
      return
    }
    pendingRef.current = { id: company.id, signers: next }
    const t = setTimeout(() => {
      if (pendingRef.current) {
        setCompanySigners(pendingRef.current.id, pendingRef.current.signers)
        pendingRef.current = null
      }
    }, 500)
    return () => clearTimeout(t)
  }, [prepared.name, prepared.role, verifiers, company])

  useEffect(() => {
    // On unmount, save anything still pending.
    return () => {
      if (pendingRef.current) {
        setCompanySigners(pendingRef.current.id, pendingRef.current.signers)
        pendingRef.current = null
      }
    }
  }, [])

  const totalA =
    autoRows.reduce((s, r) => s + (Number(r.amount) || 0), 0) +
    extraA.reduce((s, r) => s + sub(r.rate, r.qty), 0)
  const totalB = incentives.reduce((s, r) => s + sub(r.rate, r.qty), 0)
  const totalC = totalA + totalB

  if (operator === undefined || tasks === undefined) {
    return (
      <div className="flex justify-center py-20 text-brand">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (!operator) {
    return (
      <div className="py-10 text-center text-slate-500">
        <p>Operator not found.</p>
        <Button className="mt-4" onClick={() => navigate('/admin/payroll')}>Back</Button>
      </div>
    )
  }

  const setExtra = (i, k, v) => setExtraA((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  const setInc = (i, k, v) => {
    setBClean(false)
    setIncentives((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r)))
  }
  const addIncentive = () => {
    setBClean(false)
    setIncentives((p) => [...p, { desc: '', unit: 'Setiap Kes', rate: '', qty: '' }])
  }
  const removeIncentive = () => {
    setBClean(false)
    setIncentives((p) => p.slice(0, -1))
  }
  const saveB = async () => {
    setBSaving(true)
    try {
      await saveClaimIncentives(operatorId, monthKey, incentives)
      setBClean(true)
    } finally {
      setBSaving(false)
    }
  }

  // Adding/removing a verifier persists the new structure to the company at once
  // (so the extra signature block stays for next month).
  const saveSigners = (vs) => {
    if (company) {
      setCompanySigners(company.id, {
        prepared: { name: prepared.name, role: prepared.role },
        verifiers: vs.map((v) => ({ name: v.name, role: v.role }))
      })
    }
  }
  const addVerifier = () => {
    const next = [...verifiers, { name: '', role: '', date: todayStr() }]
    setVerifiers(next)
    saveSigners(next)
  }
  const removeVerifier = () => {
    const next = verifiers.slice(0, -1)
    setVerifiers(next)
    saveSigners(next)
  }

  const cell = 'border border-slate-400 px-2 py-1 text-sm'
  const numCell = `${cell} text-right`

  // Give "Save as PDF" a tidy default filename, then restore the title.
  const printSheet = () => {
    const prev = document.title
    document.title = claimPdfName(company?.name, monthKey, operator?.name)
    const restore = () => {
      document.title = prev
      window.removeEventListener('afterprint', restore)
    }
    window.addEventListener('afterprint', restore)
    window.print()
  }

  return (
    <div className="pb-6">
      <div className="print:hidden">
        <PageHeader title="Claim form" subtitle={`${operator.name} · ${monthLabel(monthKey)}`} onBack={() => navigate('/admin/payroll')} />
      </div>

      {locked && (
        <div className="mb-3 flex items-center gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-700 print:hidden">
          <IconLock width={16} height={16} /> This month is locked — the claim form is read only. Unlock it in Payroll to edit.
        </div>
      )}

      {/* ===== The printable claim form ===== */}
      <div className="rounded-lg bg-white p-3 text-slate-900 print:p-0">
        <h1 className="mb-2 text-lg font-extrabold tracking-wide">BORANG TUNTUTAN KERJA</h1>

        {/* Header info */}
        <table className="mb-4 w-full border-collapse">
          <tbody>
            {[
              ['Nama Syarikat', company?.name || ''],
              ['Nama Pengendali', operator.name],
              ['Bulan Kerja', monthLabel(monthKey)],
              ['Peralatan', machines]
            ].map(([label, value]) => (
              <tr key={label}>
                <td className="w-44 border border-slate-400 bg-slate-100 px-2 py-1 text-right text-sm font-semibold">
                  {label} :
                </td>
                <td className="border border-slate-400 px-2 py-1 text-center text-sm">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Section A */}
        <div className="bg-slate-900 px-2 py-1 text-sm font-bold text-white">Kerja yang Selesai</div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-slate-200 text-sm font-semibold">
              <th className={`${cell} w-10`}>No.</th>
              <th className={`${cell} text-left`}>Perihal Kerja</th>
              <th className={`${cell} w-24`}>Unit</th>
              <th className={`${cell} w-24`}>Kadar / Unit (RM)</th>
              <th className={`${cell} w-24`}>Jumlah Unit</th>
              <th className={`${cell} w-28`}>Subjumlah (RM)</th>
            </tr>
          </thead>
          <tbody>
            {autoRows.map((r, i) => (
              <tr key={`a-${i}`}>
                <td className={`${cell} text-center`}>{i + 1}</td>
                <td className={cell}>{r.desc}</td>
                <td className={`${cell} text-center`}>{r.unit}</td>
                <td className={numCell}>{rateFmt(r.rate)}</td>
                <td className={numCell}>{qtyFmt(r.qty)}</td>
                <td className={numCell}>{money(r.amount)}</td>
              </tr>
            ))}
            {extraA.map((r, i) => (
              <tr key={`ax-${i}`}>
                <td className={`${cell} text-center`}>{autoRows.length + i + 1}</td>
                <td className={cell}>
                  <CellInput value={r.desc} readOnly={locked} onChange={(e) => setExtra(i, 'desc', e.target.value)} />
                </td>
                <td className={`${cell} text-center`}>
                  <CellInput className="text-center" value={r.unit} readOnly={locked} onChange={(e) => setExtra(i, 'unit', e.target.value)} />
                </td>
                <td className={cell}>
                  <CellInput className="text-right" inputMode="decimal" value={r.rate} readOnly={locked} onChange={(e) => setExtra(i, 'rate', e.target.value)} />
                </td>
                <td className={cell}>
                  <CellInput className="text-right" inputMode="decimal" value={r.qty} readOnly={locked} onChange={(e) => setExtra(i, 'qty', e.target.value)} />
                </td>
                <td className={numCell}>{money(sub(r.rate, r.qty))}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} className={`${cell} text-right font-bold`}>Jumlah Tuntutan (RM):</td>
              <td className={`${numCell} font-bold`}>{money(totalA)}</td>
            </tr>
          </tbody>
        </table>
        {!locked && (
          <div className="my-2 print:hidden">
            <RowButtons
              onAdd={() => setExtraA((p) => [...p, { desc: '', unit: 'Sebulan', rate: '', qty: '1' }])}
              onRemove={extraA.length ? () => setExtraA((p) => p.slice(0, -1)) : null}
              label="salary/allowance row"
            />
          </div>
        )}

        {SHOW_INCENTIVES && (
          <>
        {/* Section B */}
        <div className="mt-4 bg-slate-900 px-2 py-1 text-sm font-bold text-white">Bahagian B : Bayaran Insentif</div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-slate-200 text-sm font-semibold">
              <th className={`${cell} w-10`}>No.</th>
              <th className={`${cell} text-left`}>Perihal</th>
              <th className={`${cell} w-24`}>Unit</th>
              <th className={`${cell} w-24`}>Kadar / Unit (RM)</th>
              <th className={`${cell} w-24`}>Jumlah Unit</th>
              <th className={`${cell} w-28`}>Subjumlah (RM)</th>
            </tr>
          </thead>
          <tbody>
            {incentives.map((r, i) => (
              <tr key={`b-${i}`}>
                <td className={`${cell} text-center`}>{i + 1}</td>
                <td className={cell}>
                  <CellInput value={r.desc} placeholder="e.g. Insentif Audit Jalan" readOnly={locked} onChange={(e) => setInc(i, 'desc', e.target.value)} />
                </td>
                <td className={`${cell} text-center`}>
                  <CellInput className="text-center" value={r.unit} readOnly={locked} onChange={(e) => setInc(i, 'unit', e.target.value)} />
                </td>
                <td className={cell}>
                  <CellInput className="text-right" inputMode="decimal" value={r.rate} readOnly={locked} onChange={(e) => setInc(i, 'rate', e.target.value)} />
                </td>
                <td className={cell}>
                  <CellInput className="text-right" inputMode="decimal" value={r.qty} readOnly={locked} onChange={(e) => setInc(i, 'qty', e.target.value)} />
                </td>
                <td className={numCell}>{money(sub(r.rate, r.qty))}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={5} className={`${cell} text-right font-bold`}>Jumlah Tuntutan (RM):</td>
              <td className={`${numCell} font-bold`}>{money(totalB)}</td>
            </tr>
          </tbody>
        </table>
        <div className="my-2 flex flex-wrap items-center justify-between gap-2 print:hidden">
          {locked ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
              <IconLock width={14} height={14} /> Month locked — read only
            </span>
          ) : (
            <>
              <RowButtons
                onAdd={addIncentive}
                onRemove={incentives.length ? removeIncentive : null}
                label="incentive row"
              />
              <div className="flex items-center gap-2">
                {!bClean ? (
                  <span className="text-xs text-amber-600">Unsaved changes</span>
                ) : savedClaim ? (
                  <span className="text-xs font-medium text-green-600">Saved ✓</span>
                ) : null}
                <Button size="sm" onClick={saveB} disabled={bSaving || bClean}>
                  {bSaving ? 'Saving…' : 'Save Bahagian B'}
                </Button>
              </div>
            </>
          )}
        </div>

        {/* Section C */}
        <div className="mt-4 bg-slate-900 px-2 py-1 text-sm font-bold text-white">Bahagian C : Ringkasan Tuntutan</div>
        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-slate-200 text-sm font-semibold">
              <th className={`${cell} w-10`}>No.</th>
              <th className={`${cell} text-left`}>Perihal</th>
              <th className={`${cell} w-40`}>Subjumlah Tuntutan (RM)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={`${cell} text-center`}>1</td>
              <td className={cell}>Bahagian A (Kerja yang Selesai) + Bahagian B (Insentif)</td>
              <td className={`${numCell} text-base font-bold`}>{money(totalC)}</td>
            </tr>
          </tbody>
        </table>
          </>
        )}

        {/* Signatures — 3 per row, compact */}
        <div className="mt-6 grid grid-cols-3 gap-3">
          <SignBlock title="Disediakan oleh:" value={prepared} onChange={setPrepared} readOnly={locked} />
          {verifiers.map((v, i) => (
            <SignBlock
              key={i}
              title="Disahkan oleh:"
              value={v}
              readOnly={locked}
              onChange={(nv) => setVerifiers((p) => p.map((x, j) => (j === i ? nv : x)))}
            />
          ))}
        </div>
        {!locked && (
          <div className="mt-3 print:hidden">
            <RowButtons
              onAdd={addVerifier}
              onRemove={verifiers.length > 1 ? removeVerifier : null}
              label="Disahkan oleh"
            />
          </div>
        )}
      </div>

      <Button full className="mt-4 print:hidden" onClick={printSheet}>
        Print / Save as PDF
      </Button>
    </div>
  )
}

function SignBlock({ title, value, onChange, readOnly = false }) {
  return (
    <div className="text-xs">
      <p className="font-semibold">{title}</p>
      <div className="mt-1 h-20 border-b border-slate-400" />
      <div className="mt-1 space-y-0.5">
        <SignLine label="Nama" value={value.name} onChange={(v) => onChange({ ...value, name: v })} readOnly={readOnly} />
        <SignLine label="Jabatan" value={value.role} onChange={(v) => onChange({ ...value, role: v })} readOnly={readOnly} />
        <SignLine label="Tarikh" value={value.date} onChange={(v) => onChange({ ...value, date: v })} readOnly={readOnly} />
      </div>
    </div>
  )
}

function SignLine({ label, value, onChange, readOnly = false }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-slate-700">{label}:</span>
      <input
        className="flex-1 bg-transparent px-1 outline-none focus:bg-brand-light/40 read-only:cursor-default read-only:focus:bg-transparent print:focus:bg-transparent"
        value={value}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function RowButtons({ onAdd, onRemove, label }) {
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="secondary" onClick={onAdd}>
        <IconPlus width={16} height={16} /> Add {label}
      </Button>
      {onRemove && (
        <Button size="sm" variant="ghost" onClick={onRemove}>
          <IconTrash width={16} height={16} /> Remove last
        </Button>
      )}
    </div>
  )
}
