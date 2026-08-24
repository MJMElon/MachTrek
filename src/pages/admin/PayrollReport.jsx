import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { getMonthTasks, listOperators, listCompanies, listClaims, isMonthLocked, setMonthLock, getLatestClaimMonth } from '../../db/repo.js'
import { getMeta } from '../../db/database.js'
import { TaskStatus } from '../../db/models.js'
import { monthKeyOf, monthLabel, shiftMonth, minRetainedMonthKey, formatMoney } from '../../lib/format.js'
import { formatHours } from '../../lib/duration.js'
import { Button, Card, EmptyState } from '../../components/ui.jsx'
import { IconChevron, IconLock, IconUnlock, IconReport } from '../../components/icons.jsx'

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100
const thisMonth = () => monthKeyOf(new Date())

function buildPayroll(tasks, { opById = new Map(), claimByOp = new Map(), companyFilter = null, companyIds = null } = {}) {
  const completed = tasks.filter(
    (t) =>
      t.status === TaskStatus.COMPLETED &&
      (!companyFilter || t.companyId === companyFilter) &&
      // Drop work whose company was deleted, so a removed company can't linger.
      (!companyIds || !t.companyId || companyIds.has(t.companyId))
  )
  const opMap = new Map()
  for (const t of completed) {
    const key = t.operatorId || `name:${(t.operatorName || '?').toLowerCase()}`
    if (!opMap.has(key)) {
      opMap.set(key, {
        key,
        operatorId: t.operatorId || null,
        name: t.operatorName || 'Unknown',
        companyName: t.companyName || 'No company',
        companyId: t.companyId || null,
        workAmount: 0, // Bahagian A piece-rate work only
        minutes: 0,
        count: 0
      })
    }
    const o = opMap.get(key)
    o.workAmount += Number(t.amount) || 0
    o.minutes += Number(t.durationMinutes) || 0
    o.count += 1
  }

  const compMap = new Map()
  for (const o of opMap.values()) {
    // Bahagian A also includes the monthly salary + phone allowance (operator
    // defaults), and Bahagian B is the saved incentives. The payroll total is
    // Bahagian C = A + B, matching the claim form.
    const opRec = o.operatorId ? opById.get(o.operatorId) : null
    o.salary = round2(Number(opRec?.basicSalary) || 0)
    o.allowance = round2(Number(opRec?.phoneAllowance) || 0)
    const claim = o.operatorId ? claimByOp.get(o.operatorId) : null
    o.incentives = (claim?.incentives || [])
      .map((r) => ({ name: r.desc || 'Insentif', amount: round2((Number(r.rate) || 0) * (Number(r.qty) || 0)) }))
      .filter((r) => r.amount !== 0)
    const incentivesTotal = o.incentives.reduce((s, r) => s + r.amount, 0)

    o.workAmount = round2(o.workAmount)
    // Bahagian A = piece work + salary + allowance, B = incentives, C = A + B.
    o.bahagianA = round2(o.workAmount + o.salary + o.allowance)
    o.bahagianB = round2(incentivesTotal)
    o.amount = round2(o.bahagianA + o.bahagianB)
    const ck = o.companyName
    if (!compMap.has(ck)) compMap.set(ck, { companyName: o.companyName, companyId: o.companyId, operators: [], total: 0 })
    const c = compMap.get(ck)
    c.operators.push(o)
    c.total += o.amount
  }

  const companies = [...compMap.values()]
    .map((c) => ({ ...c, total: round2(c.total), operators: c.operators.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.companyName.localeCompare(b.companyName))

  return { companies, grandTotal: round2(companies.reduce((s, c) => s + c.total, 0)), operatorCount: opMap.size }
}

export default function PayrollReport() {
  const navigate = useNavigate()
  const [monthKey, setMonthKey] = useState(thisMonth())

  const currency = useLiveQuery(() => getMeta('currency', 'RM'), [], 'RM')
  const tasks = useLiveQuery(() => getMonthTasks({ monthKey }), [monthKey], undefined)
  const operators = useLiveQuery(() => listOperators({ includeInactive: true }), [], [])
  const companies = useLiveQuery(() => listCompanies({ includeInactive: true }), [], undefined)
  const claims = useLiveQuery(() => listClaims({ monthKey }), [monthKey], [])
  // Latest month that actually has a claim (non-zero). undefined = still loading.
  const latestClaimMonth = useLiveQuery(() => getLatestClaimMonth(), [], undefined)

  const locked = useLiveQuery(() => isMonthLocked(monthKey), [monthKey], false)

  // On first load, if the current month has no claim yet, land on the latest
  // month that does — so a new month starts on last month's payroll until it has
  // its first claim. Runs once; the operator can still navigate freely after.
  const didInitMonth = useRef(false)
  useEffect(() => {
    if (didInitMonth.current || latestClaimMonth === undefined) return
    didInitMonth.current = true
    if (latestClaimMonth && latestClaimMonth < thisMonth()) setMonthKey(latestClaimMonth)
  }, [latestClaimMonth])

  const opById = new Map((operators || []).map((o) => [o.id, o]))
  const claimByOp = new Map((claims || []).map((c) => [c.operatorId, c]))
  // Existing companies only — once loaded, work from deleted companies is dropped.
  const companyIds = companies ? new Set(companies.map((c) => c.id)) : null
  const report = buildPayroll(tasks || [], { opById, claimByOp, companyIds })
  // Don't let "next" reach an empty new month — cap at the latest month with a
  // claim (or the current month when there are no claims at all yet).
  const forwardCap = latestClaimMonth && latestClaimMonth < thisMonth() ? latestClaimMonth : thisMonth()
  const atCurrent = monthKey >= forwardCap
  const atFloor = monthKey <= minRetainedMonthKey() // 3-year retention limit

  const lockMonth = async () => {
    if (!window.confirm(`Lock payroll for ${monthLabel(monthKey)}?\n\nRecords and payroll for this month can no longer be modified until you unlock it.`)) return
    await setMonthLock(monthKey, true)
  }
  const unlockMonth = async () => {
    const word = window.prompt(`This month is locked.\n\nType the word "unlock" to allow editing ${monthLabel(monthKey)} again.`)
    if (word == null) return
    if (word.trim().toLowerCase() !== 'unlock') {
      window.alert('Not unlocked — you must type the word "unlock" to confirm.')
      return
    }
    await setMonthLock(monthKey, false)
  }

  return (
    <div className="space-y-3 pb-4">
      <h1 className="text-lg font-bold text-slate-800">Payroll</h1>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <button
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 disabled:opacity-30"
            onClick={() => setMonthKey(shiftMonth(monthKey, -1))}
            disabled={atFloor}
            aria-label="Previous month"
          >
            <IconChevron width={20} height={20} className="rotate-180" />
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold text-slate-700">{monthLabel(monthKey)}</p>
            <p className="text-2xl font-bold text-slate-900">{formatMoney(report.grandTotal, currency)}</p>
            <p className="text-xs text-slate-500">{report.operatorCount} operators</p>
          </div>
          <button
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 disabled:opacity-30"
            onClick={() => setMonthKey(shiftMonth(monthKey, 1))}
            disabled={atCurrent}
            aria-label="Next month"
          >
            <IconChevron width={20} height={20} />
          </button>
        </div>

        {/* Lock / unlock this payroll month */}
        <div className="mt-3 border-t border-slate-100 pt-3">
          {locked ? (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2">
              <span className="flex items-center gap-1.5 text-sm font-medium text-amber-700">
                <IconLock width={16} height={16} /> Locked — records can’t be modified
              </span>
              <Button size="sm" variant="secondary" onClick={unlockMonth}>
                <IconUnlock width={16} height={16} /> Unlock
              </Button>
            </div>
          ) : (
            <Button size="sm" full variant="secondary" onClick={lockMonth}>
              <IconLock width={16} height={16} /> Lock this month
            </Button>
          )}
        </div>
      </Card>

      {report.companies.length === 0 ? (
        <EmptyState title="No completed work this month" subtitle="Payroll totals appear once operators finish tasks." />
      ) : (
        report.companies.map((company) => (
          <Card key={company.companyName} className="overflow-hidden">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate font-semibold text-slate-700">{company.companyName}</p>
                {company.companyId && (
                  <button
                    type="button"
                    onClick={() => navigate(`/admin/claims/${company.companyId}?month=${monthKey}`)}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-brand active:bg-slate-100"
                  >
                    <IconReport width={13} height={13} /> Print all
                  </button>
                )}
              </div>
              <p className="shrink-0 font-bold text-slate-900">{formatMoney(company.total, currency)}</p>
            </div>
            <div className="divide-y divide-slate-100">
              {company.operators.map((o) => (
                // Tap an operator to open their claim form for this month.
                <button
                  key={o.key}
                  className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-slate-50 disabled:cursor-default"
                  onClick={() => o.operatorId && navigate(`/admin/claim/${o.operatorId}?month=${monthKey}`)}
                  disabled={!o.operatorId}
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-800">{o.name}</p>
                    <p className="text-xs text-slate-500">
                      {formatHours(o.minutes)} · {o.count} record{o.count === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900">{formatMoney(o.amount, currency)}</span>
                    {o.operatorId && <IconChevron width={16} height={16} className="text-slate-300" />}
                  </div>
                </button>
              ))}
            </div>
          </Card>
        ))
      )}

      {report.companies.length > 0 && (
        <Card className="flex items-center justify-between p-4">
          <span className="font-semibold text-slate-700">Total payout</span>
          <span className="text-xl font-bold text-slate-900">{formatMoney(report.grandTotal, currency)}</span>
        </Card>
      )}
    </div>
  )
}
