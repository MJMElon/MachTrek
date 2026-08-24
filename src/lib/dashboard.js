// Yearly dashboard aggregation. Pure functions — given a year's tasks + the
// operators/companies, produce the chart series used by the Dashboard page.
//
// Charts (per company, Jan–Dec, one series per operator unless noted):
//   1. Speed (units / hour) per work-type. Distance-unit works (m, km…) are
//      merged into one "Road & Drain works" chart; every other unit/work type
//      gets its own chart.
//   2. Salary: NEW (piece-rate earnings) vs OLD (hours × operator hourly rate),
//      one small 2-line chart per operator.
//   3. Non-working days: calendar days in the month with no work recorded.

import { TaskStatus, HOURLY_RATE_NAME } from '../db/models.js'
import { daysInMonth } from './format.js'

export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n) => String(n).padStart(2, '0')
const monthIndex = (monthKey) => Number((monthKey || '').split('-')[1]) - 1
const norm = (s) => String(s ?? '').trim()
const hoursOf = (mins) => (Number(mins) || 0) / 60
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10

// Units that measure distance — these works are merged as "Road & Drain works".
const DISTANCE_UNITS = new Set(['m', 'meter', 'metre', 'meters', 'metres', 'km', 'kilometer', 'kilometre'])
export function isDistanceUnit(unit) {
  return DISTANCE_UNITS.has(norm(unit).toLowerCase())
}

// Day-based work ("Hari") is only ever a half day or a full day, so its
// quantity is picked from a list instead of typed.
const DAY_UNITS = new Set(['hari', 'day', 'days', 'hari kerja'])
export const DAY_QTY_CHOICES = ['0.5', '1']
export function isDayUnit(unit) {
  return DAY_UNITS.has(norm(unit).toLowerCase())
}

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#dc2626', '#65a30d', '#9333ea', '#0d9488']
export const colorFor = (i) => PALETTE[i % PALETTE.length]

const empty12 = () => Array.from({ length: 12 }, () => null)
const zeros12 = () => Array.from({ length: 12 }, () => 0)

// A task billed by the hour ("Kerja jam") vs ordinary piece-rate work.
const isHourlyTask = (t) => norm(t.pieceRateName).toLowerCase() === HOURLY_RATE_NAME.toLowerCase()

/**
 * @param {{tasks:Array, operators:Array, companies:Array, year:number, now?:Date}} a
 */
export function buildDashboard({ tasks = [], operators = [], companies = [], year, now = new Date() }) {
  const completed = tasks.filter((t) => t.status === TaskStatus.COMPLETED)

  // Real workers (exclude site admins), grouped by company.
  const workersByCompany = new Map()
  for (const o of operators) {
    if (o.isSiteAdmin) continue
    const cid = o.companyId || 'none'
    if (!workersByCompany.has(cid)) workersByCompany.set(cid, [])
    workersByCompany.get(cid).push(o)
  }

  // Tasks grouped by operator.
  const tasksByOp = new Map()
  for (const t of completed) {
    if (!t.operatorId) continue
    if (!tasksByOp.has(t.operatorId)) tasksByOp.set(t.operatorId, [])
    tasksByOp.get(t.operatorId).push(t)
  }

  // Elapsed days in a month (so the current/future months aren't counted as all
  // "non-working"): full month if past, today's date for the current month, null
  // for months that haven't happened yet.
  const curYear = now.getFullYear()
  const curMonthIdx = now.getMonth()
  const curDate = now.getDate()
  const elapsedDays = (mi) => {
    if (year > curYear) return null
    if (year === curYear && mi > curMonthIdx) return null
    if (year === curYear && mi === curMonthIdx) return curDate
    return daysInMonth(`${year}-${pad(mi + 1)}`)
  }

  const companyName = (id) => companies.find((c) => c.id === id)?.name || 'No company'

  const out = []
  for (const [cid, workers] of workersByCompany) {
    // Skip operators whose company was deleted — that data shouldn't show.
    if (cid !== 'none' && !companies.some((c) => c.id === cid)) continue
    const ops = workers
      .slice()
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      .map((o, i) => ({ id: o.id, name: o.name, color: colorFor(i), op: o }))

    // ---- 1. Speed groups (units / hour) ----
    // groupKey -> { label, unit, perOp: Map(opId -> {qty[12], hrs[12]}) }
    const groups = new Map()
    for (const op of ops) {
      for (const t of tasksByOp.get(op.id) || []) {
        const mi = monthIndex(t.monthKey)
        if (mi < 0 || mi > 11) continue
        // Skip "Kerja jam" (hourly) work — its quantity is the hours itself, so a
        // units/hour speed is meaningless (always ~1) and not worth its own chart.
        if (isHourlyTask(t)) continue
        // Skip rows that can't produce a meaningful speed: no unit (would make a
        // blank "unit/jam" chart) or no positive quantity.
        if (!norm(t.unit) || !(Number(t.quantity) > 0)) continue
        const distance = isDistanceUnit(t.unit)
        const key = distance ? 'road-drain' : `rate:${norm(t.pieceRateName) || 'work'}`
        const label = distance ? 'Road & Drain works' : norm(t.pieceRateName) || 'Work'
        const unit = distance ? 'm' : norm(t.unit)
        if (!groups.has(key)) groups.set(key, { key, label, unit, perOp: new Map() })
        const g = groups.get(key)
        if (!g.perOp.has(op.id)) g.perOp.set(op.id, { qty: empty12(), hrs: empty12() })
        const cell = g.perOp.get(op.id)
        cell.qty[mi] = (cell.qty[mi] || 0) + (Number(t.quantity) || 0)
        cell.hrs[mi] = (cell.hrs[mi] || 0) + hoursOf(t.durationMinutes)
      }
    }
    const speedGroups = [...groups.values()]
      .map((g) => {
        const series = ops
          .map((op) => {
            const cell = g.perOp.get(op.id)
            if (!cell) return null
            const values = cell.qty.map((q, mi) => {
              const h = cell.hrs[mi]
              return q != null && h ? round2(q / h) : null
            })
            return values.some((v) => v != null) ? { name: op.name, color: op.color, values } : null
          })
          .filter(Boolean)
        return { ...g, series }
      })
      .filter((g) => g.series.length)
      .sort((a, b) => (a.key === 'road-drain' ? -1 : b.key === 'road-drain' ? 1 : a.label.localeCompare(b.label)))

    // Road & Drain works total (meters) per operator — the same merged distance
    // work as the speed chart, but the raw quantity instead of speed.
    const rd = groups.get('road-drain')
    const roadDrainSeries = rd
      ? ops
          .map((op) => {
            const cell = rd.perOp.get(op.id)
            if (!cell) return null
            const values = cell.qty.map((q) => (q != null ? round2(q) : null))
            return values.some((v) => v != null) ? { name: op.name, color: op.color, values } : null
          })
          .filter(Boolean)
      : []

    // ---- 2. Salary: new (piece) vs old (hourly) per operator ----
    // New = piece-rate work + basic salary + phone allowance — identical to the
    // claim form's Bahagian A. Old = rounded hours × hourly rate + basic salary
    // (no allowance). Basic/allowance apply per month that has work.
    const salaryByOperator = ops
      .map((op) => {
        const list = tasksByOp.get(op.id) || []
        if (!list.length) return null
        const work = empty12() // piece-rate earnings per month
        const hrs = empty12()
        for (const t of list) {
          const mi = monthIndex(t.monthKey)
          if (mi < 0 || mi > 11) continue
          work[mi] = (work[mi] || 0) + (Number(t.amount) || 0)
          hrs[mi] = (hrs[mi] || 0) + hoursOf(t.durationMinutes)
        }
        const rate = Number(op.op.hourlyRate)
        const hasOld = Number.isFinite(rate) && rate > 0
        const basic = Number(op.op.basicSalary) || 0
        const allowance = Number(op.op.phoneAllowance) || 0
        // New = piece work + basic + phone allowance (same as the claim form).
        const newVals = work.map((w) => (w != null ? round2(w + basic + allowance) : 0))
        // Old = rounded hours × hourly rate + basic. Hours are rounded to 1
        // decimal first (same as the displayed total) — e.g. 26.07 h → 26.1 h × RM9.
        const oldVals = hrs.map((h) => (hasOld && h != null ? round2(round1(h) * rate + basic) : null))
        return {
          operatorId: op.id,
          name: op.name,
          hasOld,
          series: [
            { name: 'New (piece rate)', color: '#16a34a', values: newVals },
            { name: 'Old (hourly)', color: '#d97706', values: oldVals }
          ]
        }
      })
      .filter(Boolean)

    // ---- 3. Non-working days per operator ----
    const nonWorkingSeries = ops.map((op) => {
      const days = empty12()
      for (const t of tasksByOp.get(op.id) || []) {
        const mi = monthIndex(t.monthKey)
        if (mi < 0 || mi > 11 || !t.dayKey) continue
        if (!days[mi]) days[mi] = new Set()
        days[mi].add(t.dayKey)
      }
      const values = Array.from({ length: 12 }, (_, mi) => {
        const ed = elapsedDays(mi)
        if (ed == null) return null
        const worked = days[mi] ? days[mi].size : 0
        return Math.max(0, ed - worked)
      })
      return { name: op.name, color: op.color, values }
    })

    // ---- 4. Work-hours mix: Kerja jam vs other piece-rate (stacked area) ----
    // Per operator, monthly hours split into Kerja jam (hourly) work and all
    // other piece-rate work. The two series stack: red base = Kerja jam hours,
    // blue on top = the rest, so the blue line is the operator's total hours.
    const durationByOperator = ops
      .map((op) => {
        const kerjaJam = zeros12()
        const other = zeros12()
        let any = false
        for (const t of tasksByOp.get(op.id) || []) {
          const mi = monthIndex(t.monthKey)
          if (mi < 0 || mi > 11) continue
          const h = hoursOf(t.durationMinutes)
          if (!h) continue
          // Sum raw hours; round once below so per-task rounding can't accumulate.
          if (isHourlyTask(t)) kerjaJam[mi] += h
          else other[mi] += h
          any = true
        }
        if (!any) return null
        return {
          operatorId: op.id,
          name: op.name,
          series: [
            // Hours shown to 1 decimal, same convention as the rest of the app.
            { name: 'Kerja jam', color: '#dc2626', values: kerjaJam.map(round1) },
            { name: 'Kerja piece rated', color: '#2563eb', values: other.map(round1) }
          ]
        }
      })
      .filter(Boolean)

    const hasData = speedGroups.length > 0 || salaryByOperator.length > 0 || durationByOperator.length > 0
    out.push({
      id: cid,
      name: companyName(cid === 'none' ? null : cid),
      operators: ops.map(({ id, name, color }) => ({ id, name, color })),
      speedGroups,
      roadDrainSeries,
      salaryByOperator,
      durationByOperator,
      nonWorkingSeries,
      hasData
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name))
  return { year, companies: out }
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100
}
