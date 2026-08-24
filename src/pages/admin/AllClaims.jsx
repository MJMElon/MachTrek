import { useMemo } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { getCompany, getMonthTasks, listOperators } from '../../db/repo.js'
import { TaskStatus } from '../../db/models.js'
import { monthKeyOf, monthLabel, claimPdfName } from '../../lib/format.js'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Spinner, EmptyState } from '../../components/ui.jsx'

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

// Section A rows for one operator: completed piece-rate work, split by work type
// + area (e.g. "Compact jalan (Phase 1)"), same as the single claim form.
function buildAutoRows(tasks) {
  const map = new Map()
  for (const t of tasks) {
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
  // Hide rows that contribute nothing — e.g. work completed without a quantity
  // (0 jumlah unit and 0 amount) — so they don't clutter the claim.
  return [...map.values()]
    .filter((r) => Number(r.qty) !== 0 || Number(r.amount) !== 0)
    .sort((a, b) => a.work.localeCompare(b.work) || a.loc.localeCompare(b.loc))
}

// One operator's printable claim sheet (read-only — uses saved data).
function ClaimSheet({ companyName, operator, monthKey, autoRows, extraA, totalA, machines, signers }) {
  const cell = 'border border-slate-400 px-2 py-1 text-sm'
  const numCell = `${cell} text-right`
  const verifiers = signers?.verifiers?.length ? signers.verifiers : [{ name: '', role: '' }]
  const today = todayStr()
  return (
    <div className="rounded-lg bg-white p-3 text-slate-900 print:rounded-none print:p-0">
      <h1 className="mb-2 text-lg font-extrabold tracking-wide">BORANG TUNTUTAN KERJA</h1>

      <table className="mb-4 w-full border-collapse">
        <tbody>
          {[
            ['Nama Syarikat', companyName],
            ['Nama Pengendali', operator.name],
            ['Bulan Kerja', monthLabel(monthKey)],
            ['Peralatan', machines]
          ].map(([label, value]) => (
            <tr key={label}>
              <td className="w-44 border border-slate-400 bg-slate-100 px-2 py-1 text-right text-sm font-semibold">{label} :</td>
              <td className="border border-slate-400 px-2 py-1 text-center text-sm">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

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
              <td className={cell}>{r.desc}</td>
              <td className={`${cell} text-center`}>{r.unit}</td>
              <td className={numCell}>{r.rate === '' ? '' : rateFmt(r.rate)}</td>
              <td className={numCell}>{qtyFmt(r.qty)}</td>
              <td className={numCell}>{money(sub(r.rate, r.qty))}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={5} className={`${cell} text-right font-bold`}>Jumlah Tuntutan (RM):</td>
            <td className={`${numCell} font-bold`}>{money(totalA)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <SignBlock title="Disediakan oleh:" name={signers?.prepared?.name} role={signers?.prepared?.role} date={today} />
        {verifiers.map((v, i) => (
          <SignBlock key={i} title="Disahkan oleh:" name={v.name} role={v.role} date={today} />
        ))}
      </div>
    </div>
  )
}

function SignBlock({ title, name, role, date }) {
  return (
    <div className="text-xs">
      <p className="font-semibold">{title}</p>
      <div className="mt-1 h-20 border-b border-slate-400" />
      <div className="mt-1 space-y-0.5 text-slate-700">
        <p>Nama: {name || ''}</p>
        <p>Jabatan: {role || ''}</p>
        <p>Tarikh: {date || ''}</p>
      </div>
    </div>
  )
}

// All operators' claim forms for one company + month, one per printed page.
export default function AllClaims() {
  const { companyId } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const monthKey = searchParams.get('month') || monthKeyOf(new Date())

  const company = useLiveQuery(async () => (await getCompany(companyId)) ?? null, [companyId])
  const operators = useLiveQuery(() => listOperators({ includeInactive: true }), [], undefined)
  const tasks = useLiveQuery(() => getMonthTasks({ monthKey }), [monthKey], undefined)

  const claims = useMemo(() => {
    if (!operators || !tasks) return []
    // Completed work for this company, grouped by operator.
    const byOp = new Map()
    for (const t of tasks) {
      if (t.status !== TaskStatus.COMPLETED || t.companyId !== companyId || !t.operatorId) continue
      if (!byOp.has(t.operatorId)) byOp.set(t.operatorId, [])
      byOp.get(t.operatorId).push(t)
    }
    return [...byOp.entries()]
      .map(([opId, opTasks]) => {
        const o = operators.find((x) => x.id === opId)
        if (!o) return null
        const autoRows = buildAutoRows(opTasks)
        const extraA = []
        if (o.basicSalary != null) extraA.push({ desc: 'Gaji Bulanan', unit: 'Sebulan', rate: String(o.basicSalary), qty: '1' })
        if (o.phoneAllowance != null) extraA.push({ desc: 'Elaun telephone', unit: 'Sebulan', rate: String(o.phoneAllowance), qty: '1' })
        const totalA =
          autoRows.reduce((s, r) => s + (Number(r.amount) || 0), 0) + extraA.reduce((s, r) => s + sub(r.rate, r.qty), 0)
        const machines = [...new Set(opTasks.map((t) => t.machineName).filter(Boolean))].join(', ')
        return { operator: o, autoRows, extraA, totalA, machines }
      })
      .filter(Boolean)
      .sort((a, b) => (a.operator.name || '').localeCompare(b.operator.name || ''))
  }, [operators, tasks, companyId])

  // Set the document title so "Save as PDF" defaults to a tidy filename, then
  // restore it once the print dialog closes.
  const printAll = () => {
    const prev = document.title
    document.title = claimPdfName(company?.name, monthKey)
    const restore = () => {
      document.title = prev
      window.removeEventListener('afterprint', restore)
    }
    window.addEventListener('afterprint', restore)
    window.print()
  }

  if (company === undefined || operators === undefined || tasks === undefined) {
    return (
      <div className="flex justify-center py-20 text-brand">
        <Spinner className="h-7 w-7" />
      </div>
    )
  }
  if (!company) {
    return (
      <div className="py-10 text-center text-slate-500">
        <p>Company not found.</p>
        <Button className="mt-4" onClick={() => navigate('/admin/payroll')}>
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="pb-6">
      <div className="print:hidden">
        <PageHeader
          title="All claim forms"
          subtitle={`${company.name} · ${monthLabel(monthKey)} · ${claims.length} operator${claims.length === 1 ? '' : 's'}`}
          onBack={() => navigate('/admin/payroll')}
        />
      </div>

      {claims.length === 0 ? (
        <EmptyState title="No claims this month" subtitle="No operator has completed work for this company in this month." />
      ) : (
        <>
          <div className="space-y-6 print:space-y-0">
            {claims.map((c, idx) => (
              <div key={c.operator.id} className={idx < claims.length - 1 ? 'break-after-page' : ''}>
                <ClaimSheet
                  companyName={company.name}
                  operator={c.operator}
                  monthKey={monthKey}
                  autoRows={c.autoRows}
                  extraA={c.extraA}
                  totalA={c.totalA}
                  machines={c.machines}
                  signers={company.signers}
                />
              </div>
            ))}
          </div>

          <Button full className="mt-4 print:hidden" onClick={printAll}>
            Print all {claims.length} claim{claims.length === 1 ? '' : 's'} / Save as PDF
          </Button>
        </>
      )}
    </div>
  )
}
