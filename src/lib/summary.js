// Monthly summary aggregation.
//
// Rule (from the spec): within a single day, records of the SAME piece rate are
// merged into one line and their quantities + amounts are summed. Expanding a
// merged line shows the individual records (with their times) underneath.
//
// Only COMPLETED tasks contribute to totals; IN_PROGRESS ("hanging") tasks are
// reported separately so the operator can see what still needs finishing.

import { TaskStatus } from '../db/models.js'
import { daysInMonth, pad } from './format.js'

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100

/**
 * @param {Array} tasks  tasks already filtered to one month (any operators)
 * @param {string} monthKey  "YYYY-MM"
 */
export function buildMonthlySummary(tasks, monthKey) {
  const completed = tasks.filter((t) => t.status === TaskStatus.COMPLETED)
  const open = tasks.filter((t) => t.status === TaskStatus.IN_PROGRESS)

  // Total worked time — summed from each record's duration alone.
  const totalMinutes = completed.reduce((s, t) => s + (Number(t.durationMinutes) || 0), 0)

  // dayKey -> { rateKey -> group }
  const byDay = new Map()
  for (const t of completed) {
    const dayKey = t.dayKey || monthKey + '-01'
    if (!byDay.has(dayKey)) byDay.set(dayKey, new Map())
    const groups = byDay.get(dayKey)

    // Merge on the piece rate. Records with no rate fall under "Unspecified".
    const rateKey = t.pieceRateId || `name:${t.pieceRateName || 'unspecified'}`
    if (!groups.has(rateKey)) {
      groups.set(rateKey, {
        rateKey,
        pieceRateId: t.pieceRateId || null,
        pieceRateName: t.pieceRateName || 'Unspecified',
        unit: t.unit || '',
        totalQty: 0,
        totalAmount: 0,
        records: []
      })
    }
    const g = groups.get(rateKey)
    g.totalQty += Number(t.quantity) || 0
    g.totalAmount += Number(t.amount) || 0
    if (!g.unit && t.unit) g.unit = t.unit
    g.records.push(t)
  }

  // Materialise, sorted day 1 -> end of month, groups by name, records by time.
  const days = []
  let monthTotalAmount = 0
  let recordCount = 0

  for (const [dayKey, groupsMap] of byDay) {
    const groups = [...groupsMap.values()].map((g) => ({
      ...g,
      totalQty: round2(g.totalQty),
      totalAmount: round2(g.totalAmount),
      records: g.records.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
    }))
    groups.sort((a, b) => a.pieceRateName.localeCompare(b.pieceRateName))

    const dayTotal = round2(groups.reduce((s, g) => s + g.totalAmount, 0))
    const dayRecords = groups.reduce((s, g) => s + g.records.length, 0)
    monthTotalAmount += dayTotal
    recordCount += dayRecords

    days.push({ dayKey, dayNumber: dayNumberOf(dayKey), groups, totalAmount: dayTotal, recordCount: dayRecords })
  }

  days.sort((a, b) => a.dayKey.localeCompare(b.dayKey))

  return {
    monthKey,
    totalDays: daysInMonth(monthKey),
    days,
    open, // hanging tasks (not in totals)
    openCount: open.length,
    recordCount,
    totalMinutes,
    monthTotalAmount: round2(monthTotalAmount)
  }
}

function dayNumberOf(dayKey) {
  const n = Number(dayKey.split('-')[2])
  return Number.isFinite(n) ? n : null
}

// Re-exported for callers that want the same padding helper.
export { pad }
