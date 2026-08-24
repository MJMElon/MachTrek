import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { getYearTasks, listOperators, listCompanies } from '../../db/repo.js'
import { getMeta } from '../../db/database.js'
import { formatMoney, minRetainedMonthKey } from '../../lib/format.js'
import { buildDashboard } from '../../lib/dashboard.js'
import { BarChart, StackedAreaChart } from '../../components/Chart.jsx'
import { Card, EmptyState, Spinner } from '../../components/ui.jsx'
import { IconChevron } from '../../components/icons.jsx'

const thisYear = () => new Date().getFullYear()

export default function Dashboard() {
  const [year, setYear] = useState(thisYear())

  const tasks = useLiveQuery(() => getYearTasks(year), [year], undefined)
  const operators = useLiveQuery(() => listOperators({ includeInactive: true }), [], [])
  const companies = useLiveQuery(() => listCompanies({ includeInactive: true }), [], [])
  const currency = useLiveQuery(() => getMeta('currency', 'RM'), [], 'RM')

  const data = useMemo(
    () => buildDashboard({ tasks: tasks || [], operators: operators || [], companies: companies || [], year }),
    [tasks, operators, companies, year]
  )

  const loading = tasks === undefined
  const atCurrent = year >= thisYear()
  // Same 3-year (36-month) retention window as Records/Payroll: don't navigate
  // earlier than the oldest year that still has retained data.
  const floorYear = Number(minRetainedMonthKey().slice(0, 4))
  const atFloor = year <= floorYear
  const moneyFmt = (v) => formatMoney(v, currency)

  // One company in view at a time, switched via tabs. Only companies that have
  // chart data get a tab; keep the active one valid as the year changes.
  const [activeCompanyId, setActiveCompanyId] = useState('')
  const companiesWithData = useMemo(() => data.companies.filter((c) => c.hasData), [data])
  useEffect(() => {
    if (!companiesWithData.length) return
    if (!companiesWithData.some((c) => c.id === activeCompanyId)) {
      setActiveCompanyId(companiesWithData[0].id)
    }
  }, [companiesWithData, activeCompanyId])
  const activeCompany = companiesWithData.find((c) => c.id === activeCompanyId) || companiesWithData[0] || null

  return (
    <div className="space-y-3 pb-4">
      <h1 className="text-lg font-bold text-slate-800">Dashboard</h1>

      {/* Year navigator */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <button
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 disabled:opacity-30"
            onClick={() => setYear((y) => y - 1)}
            disabled={atFloor}
            aria-label="Previous year"
          >
            <IconChevron width={20} height={20} className="rotate-180" />
          </button>
          <p className="text-2xl font-bold text-slate-900">{year}</p>
          <button
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 disabled:opacity-30"
            onClick={() => setYear((y) => y + 1)}
            disabled={atCurrent}
            aria-label="Next year"
          >
            <IconChevron width={20} height={20} />
          </button>
        </div>
        <p className="mt-1 text-center text-xs text-slate-500">Operator comparison · Jan–Dec</p>
      </Card>

      {loading ? (
        <div className="flex justify-center py-16 text-brand">
          <Spinner className="h-7 w-7" />
        </div>
      ) : !companiesWithData.length ? (
        <EmptyState title="No work recorded this year" subtitle="Charts appear once operators have completed tasks." />
      ) : (
        <>
          {/* Company tabs — only when there's more than one company with data */}
          {companiesWithData.length > 1 && (
            <Card className="overflow-hidden">
              <div className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200 px-2 pt-1">
                {companiesWithData.map((c) => {
                  const on = c.id === activeCompany?.id
                  return (
                    <button
                      key={c.id}
                      onClick={() => setActiveCompanyId(c.id)}
                      className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors ${
                        on ? 'border-brand text-brand' : 'border-transparent text-slate-500'
                      }`}
                    >
                      {c.name}
                    </button>
                  )
                })}
              </div>
            </Card>
          )}
          {activeCompany && <CompanyDashboard key={activeCompany.id} company={activeCompany} moneyFmt={moneyFmt} />}
        </>
      )}
    </div>
  )
}

function CompanyDashboard({ company, moneyFmt }) {
  if (!company.hasData) return null
  return (
    <Card className="space-y-4 p-4">
      <p className="text-base font-bold text-slate-800">{company.name}</p>

      {/* The four main charts — 2×2 on desktop, stacked one-per-row on phones. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Speed per work type */}
        <Section title="Kelajuan pengendali (unit / jam)">
          {company.speedGroups.length === 0 ? (
            <Hint>No measured work yet.</Hint>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {company.speedGroups.map((g) => (
                <BarChart key={g.key} title={g.label} unit={`${g.unit}/jam`} series={g.series} />
              ))}
            </div>
          )}
        </Section>

        {/* Total Road & Drain works (metres, not speed) */}
        <Section title="Jumlah kerja Road & Drain (meter)">
          {company.roadDrainSeries.length === 0 ? (
            <Hint>No road &amp; drain work yet.</Hint>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              <BarChart title="Meter" series={company.roadDrainSeries} />
            </div>
          )}
        </Section>

        {/* Salary: new vs old */}
        <Section title="Gaji: sistem baru (kadar kerja) vs lama (ikut jam)">
          {company.salaryByOperator.length === 0 ? (
            <Hint>No earnings yet.</Hint>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {company.salaryByOperator.map((o) => (
                <div key={o.operatorId}>
                  <BarChart title={o.name} unit={currencyHint(o)} series={o.series} formatValue={moneyFmt} />
                  {!o.hasOld && (
                    <p className="px-1 pt-0.5 text-[11px] text-amber-600">
                      Set this operator’s “Kerja jam” (hourly) rate in Settings to compare.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Work-hours mix: Kerja jam (red) stacked under other piece-rate work (blue) */}
        <Section title="Jam kerja: Kerja jam (merah) + Kerja piece rated (biru)">
          {company.durationByOperator.length === 0 ? (
            <Hint>No hours recorded yet.</Hint>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {company.durationByOperator.map((o) => (
                <StackedAreaChart key={o.operatorId} title={o.name} unit="jam" series={o.series} />
              ))}
            </div>
          )}
        </Section>
      </div>

      {/* Non-working days */}
      <Section title="Hari tidak bekerja (tiada rekod kerja)">
        <BarChart title="Bilangan hari" unit="hari" series={company.nonWorkingSeries} thin />
      </Section>
    </Card>
  )
}

const currencyHint = (o) => (o.hasOld ? 'RM' : 'RM · new only')

function Section({ title, children }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      {children}
    </div>
  )
}

function Hint({ children }) {
  return <p className="text-xs text-slate-500">{children}</p>
}
