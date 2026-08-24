import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { getOperator, getCompany, getMonthTasks } from '../../db/repo.js'
import { TaskStatus } from '../../db/models.js'
import { monthKeyOf, monthLabel, daysInMonth } from '../../lib/format.js'
import { formatHours } from '../../lib/duration.js'
import PageHeader from '../../components/PageHeader.jsx'
import { Button, Spinner } from '../../components/ui.jsx'

const pad = (n) => String(n).padStart(2, '0')
// Malay weekday names (getDay(): 0 = Sunday).
const WEEKDAYS = ['Ahad', 'Isnin', 'Selasa', 'Rabu', 'Khamis', 'Jumaat', 'Sabtu']

// Printable daily worklog: every day of the month, the work done (piece rate or
// "Kerja jam"), the hours, and any notes.
export default function Worklog() {
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
        <Button className="mt-4" onClick={() => navigate('/admin/records')}>
          Back
        </Button>
      </div>
    )
  }

  const [y, m] = monthKey.split('-').map(Number)
  const numDays = daysInMonth(monthKey)

  // Completed work grouped by day, each day's tasks ordered by start time.
  const byDay = new Map()
  for (const t of tasks) {
    if (t.status !== TaskStatus.COMPLETED || !t.dayKey) continue
    if (!byDay.has(t.dayKey)) byDay.set(t.dayKey, [])
    byDay.get(t.dayKey).push(t)
  }
  for (const arr of byDay.values()) arr.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
  const totalMinutes = [...byDay.values()].flat().reduce((s, t) => s + (Number(t.durationMinutes) || 0), 0)

  const cell = 'border border-slate-400 px-2 py-1 text-sm align-top'

  return (
    <div className="pb-6">
      <div className="print:hidden">
        <PageHeader
          title="Daily worklog"
          subtitle={`${operator.name} · ${monthLabel(monthKey)}`}
          onBack={() => navigate(`/admin/records?operator=${operatorId}&month=${monthKey}`)}
        />
      </div>

      <div className="rounded-lg bg-white p-3 text-slate-900 print:p-0">
        <h1 className="mb-2 text-lg font-extrabold tracking-wide">JADUAL KERJA HARIAN</h1>

        <table className="mb-4 w-full border-collapse">
          <tbody>
            {[
              ['Nama Syarikat', company?.name || ''],
              ['Nama Pengendali', operator.name],
              ['Bulan', monthLabel(monthKey)]
            ].map(([label, value]) => (
              <tr key={label}>
                <td className="w-40 border border-slate-400 bg-slate-100 px-2 py-1 text-right text-sm font-semibold">
                  {label} :
                </td>
                <td className="border border-slate-400 px-2 py-1 text-sm">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="w-full border-collapse">
          <thead>
            <tr className="bg-slate-200 text-sm font-semibold">
              <th className={`${cell} w-28`}>Tarikh</th>
              <th className={`${cell} text-left`}>Perihal Kerja</th>
              <th className={`${cell} w-20`}>Jam</th>
              <th className={`${cell} text-left`}>Catatan</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: numDays }, (_, idx) => {
              const d = idx + 1
              const dayTasks = byDay.get(`${monthKey}-${pad(d)}`) || []
              const dateLabel = `${pad(d)}/${pad(m)} · ${WEEKDAYS[new Date(y, m - 1, d).getDay()]}`
              if (dayTasks.length === 0) {
                return (
                  <tr key={d}>
                    <td className={`${cell} whitespace-nowrap`}>{dateLabel}</td>
                    <td className={cell}></td>
                    <td className={`${cell} text-center`}></td>
                    <td className={cell}></td>
                  </tr>
                )
              }
              return dayTasks.map((t, i) => (
                <tr key={`${d}-${i}`}>
                  {i === 0 && (
                    <td className={`${cell} whitespace-nowrap`} rowSpan={dayTasks.length}>
                      {dateLabel}
                    </td>
                  )}
                  <td className={cell}>{t.pieceRateName || '—'}</td>
                  <td className={`${cell} whitespace-nowrap text-center`}>{formatHours(t.durationMinutes || 0)}</td>
                  <td className={cell}>{t.notes || ''}</td>
                </tr>
              ))
            })}
            <tr className="bg-slate-100 font-bold">
              <td className={`${cell} text-right`} colSpan={2}>
                Jumlah Jam
              </td>
              <td className={`${cell} whitespace-nowrap text-center`}>{formatHours(totalMinutes)}</td>
              <td className={cell}></td>
            </tr>
          </tbody>
        </table>
      </div>

      <Button full className="mt-4 print:hidden" onClick={() => window.print()}>
        Print / Save as PDF
      </Button>
    </div>
  )
}
