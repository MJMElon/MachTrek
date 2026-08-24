import { useState } from 'react'
import { buildMonthlySummary } from '../lib/summary.js'
import { monthLabel, shiftMonth, monthKeyOf, minRetainedMonthKey, formatMoney, formatQty, timeOf } from '../lib/format.js'
import { formatHours } from '../lib/duration.js'
import { Card, Badge, EmptyState } from './ui.jsx'
import { IconChevron, IconWarning } from './icons.jsx'
import { SyncStatusDot } from './SyncStatusDot.jsx'

const thisMonth = () => monthKeyOf(new Date())

// Who entered a record — distinct label + colour.
function createdByBadge(createdBy, ms = false) {
  if (createdBy === 'admin') return { text: ms ? 'Admin HQ' : 'HQ admin', color: 'blue' }
  if (createdBy === 'siteadmin') return { text: ms ? 'Admin Tapak' : 'Site admin', color: 'amber' }
  return { text: ms ? 'Sendiri' : 'Operator', color: 'green' }
}

/**
 * Monthly summary. Same piece rate on the same day is merged into one line;
 * expanding a line reveals the individual records.
 *
 * Props:
 *   tasks         - tasks already scoped to `monthKey`
 *   monthKey, onMonthChange
 *   currency
 *   showOperator  - include operator name on records (admin)
 *   onRecordClick - (task) => void; if set, records are tappable (admin edit)
 *   onOpenClick   - (task) => void; tap a hanging task
 */
export default function MonthSummary({
  tasks,
  monthKey,
  onMonthChange,
  currency = 'RM',
  showOperator = false,
  onRecordClick,
  onOpenClick,
  language = 'en'
}) {
  const ms = language === 'ms'
  const summary = buildMonthlySummary(tasks || [], monthKey)
  const atCurrent = monthKey >= thisMonth()
  const atFloor = monthKey <= minRetainedMonthKey() // 3-year retention limit

  return (
    <div className="space-y-3">
      {/* Month navigator + total */}
      <Card className="p-4">
        <div className="flex items-center justify-between">
          <button
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 disabled:opacity-30"
            onClick={() => onMonthChange(shiftMonth(monthKey, -1))}
            disabled={atFloor}
            aria-label={ms ? 'Bulan lepas' : 'Previous month'}
          >
            <IconChevron width={20} height={20} className="rotate-180" />
          </button>
          <div className="text-center">
            <p className="text-sm font-semibold text-slate-700">{monthLabel(monthKey, ms ? 'ms-MY' : undefined)}</p>
            <p className="text-2xl font-bold text-slate-900">
              {formatMoney(summary.monthTotalAmount, currency)}
            </p>
          </div>
          <button
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 active:bg-slate-100 disabled:opacity-30"
            onClick={() => onMonthChange(shiftMonth(monthKey, 1))}
            disabled={atCurrent}
            aria-label={ms ? 'Bulan depan' : 'Next month'}
          >
            <IconChevron width={20} height={20} />
          </button>
        </div>
        <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs text-slate-500">
          <span>{summary.recordCount} {ms ? 'rekod' : 'records'}</span>
          <span>·</span>
          <span>{summary.days.length} {ms ? 'hari kerja' : 'working days'}</span>
          <span>·</span>
          <span>{formatHours(summary.totalMinutes)}</span>
          {summary.openCount > 0 && (
            <>
              <span>·</span>
              <span className="text-amber-600">{summary.openCount} {ms ? 'belum siap' : 'unfinished'}</span>
            </>
          )}
        </div>
      </Card>

      {/* Hanging / unfinished tasks */}
      {summary.open.length > 0 && (
        <div>
          <p className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-amber-600">
            {ms ? 'Belum siap' : 'Unfinished tasks'}
          </p>
          <div className="space-y-2">
            {summary.open.map((t) => (
              <button
                key={t.id}
                onClick={() => onOpenClick?.(t)}
                className="flex w-full items-center justify-between rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-left"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-700">
                    {ms ? 'Mula' : 'Started'} {timeOf(t.startTime)}
                    {showOperator ? ` · ${t.operatorName}` : ''}
                  </p>
                  <p className="text-xs text-amber-600">{ms ? 'Tekan untuk siap' : 'Tap to finish'}</p>
                </div>
                <IconChevron width={18} height={18} className="text-amber-400" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Days */}
      {summary.days.length === 0 ? (
        <EmptyState
          title={ms ? 'Tiada kerja siap bulan ini' : 'No completed work this month'}
          subtitle={ms ? 'Rekod siap akan dipaparkan di sini.' : 'Finished records will appear here, grouped by day.'}
        />
      ) : (
        summary.days.map((day) => (
          <DayCard
            key={day.dayKey}
            day={day}
            currency={currency}
            showOperator={showOperator}
            onRecordClick={onRecordClick}
            language={language}
          />
        ))
      )}
    </div>
  )
}

function DayCard({ day, currency, showOperator, onRecordClick, language }) {
  const ms = language === 'ms'
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-4 py-2">
        <p className="text-sm font-semibold text-slate-700">{dayHeading(day.dayKey, ms ? 'ms-MY' : undefined)}</p>
        <p className="text-sm font-bold text-slate-900">{formatMoney(day.totalAmount, currency)}</p>
      </div>
      <div className="divide-y-2 divide-slate-200">
        {day.groups.map((g) => (
          <RateGroup
            key={g.rateKey}
            group={g}
            currency={currency}
            showOperator={showOperator}
            onRecordClick={onRecordClick}
            language={language}
          />
        ))}
      </div>
    </Card>
  )
}

function RateGroup({ group, currency, showOperator, onRecordClick, language }) {
  const ms = language === 'ms'
  const [open, setOpen] = useState(false)
  const multiple = group.records.length > 1
  return (
    <div>
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left active:bg-slate-50"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium text-slate-800">
            {group.pieceRateName === 'Unspecified' && (
              <IconWarning width={14} height={14} className="shrink-0 text-amber-500" aria-label={ms ? 'Kadar belum dipilih' : 'No piece rate set'} />
            )}
            {group.pieceRateName === 'Unspecified' && ms ? 'Belum dipilih' : group.pieceRateName}
          </p>
          <p className="text-xs text-slate-500">
            {formatQty(group.totalQty, group.unit)}
            {multiple ? ` · ${group.records.length} ${ms ? 'rekod' : 'entries'}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-700">{formatMoney(group.totalAmount, currency)}</span>
          <IconChevron
            width={16}
            height={16}
            className={`text-slate-300 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {open && (
        <div className="space-y-1 bg-slate-50/60 px-2.5 pb-2.5">
          {group.records.map((t) => (
            <RecordRow
              key={t.id}
              task={t}
              currency={currency}
              showOperator={showOperator}
              onClick={onRecordClick ? () => onRecordClick(t) : undefined}
              language={language}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function RecordRow({ task, currency, showOperator, onClick, language }) {
  const ms = language === 'ms'
  // Flag records where the piece rate or quantity was left blank. "Kerja jam"
  // has no rate id but does carry a name, so treat a present name as "has a rate".
  const incomplete = (task.pieceRateId == null && !task.pieceRateName) || task.quantity == null
  // For hour-based work (Kerja jam) the quantity already is the hours, so the
  // duration would be redundant — show the unit only.
  const unitIsHours = (task.unit || '').toLowerCase() === 'jam'
  // Non-hourly work is expected to have a duration; flag it when missing.
  const noDuration = !unitIsHours && task.durationMinutes == null
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-md border border-slate-100 bg-white px-2.5 py-1.5 text-left ${
        onClick ? 'active:bg-slate-100' : 'cursor-default'
      }`}
    >
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-xs text-slate-700">
          {(incomplete || noDuration) && (
            <IconWarning width={12} height={12} className="shrink-0 text-amber-500" aria-label={ms ? 'Rekod belum lengkap' : 'Incomplete record'} />
          )}
          <span className="truncate">
            {task.quantity == null ? ms ? 'Tiada kuantiti' : 'No quantity' : formatQty(task.quantity, task.unit)}
            {!unitIsHours && task.durationMinutes != null ? ` · ${formatHours(task.durationMinutes)}` : ''}
          </span>
          {noDuration && <span className="shrink-0 font-medium text-amber-600">· {ms ? 'tiada tempoh' : 'no duration'}</span>}
        </p>
        <div className="mt-0.5 flex items-center gap-1">
          <Badge color={createdByBadge(task.createdBy, ms).color} className="px-1.5 py-0 text-[10px]">
            {createdByBadge(task.createdBy, ms).text}
          </Badge>
          <span className="truncate text-[11px] text-slate-500">
            {task.areaName || (ms ? 'Tiada kawasan' : 'No area')}
            {task.machineName ? ` · ${task.machineName}` : ''}
            {showOperator ? ` · ${task.operatorName}` : ''}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-slate-700">{formatMoney(task.amount, currency)}</span>
        <SyncStatusDot status={task.syncStatus} language={language} />
      </div>
    </button>
  )
}

function dayHeading(dayKey, locale) {
  const [y, m, d] = dayKey.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(locale, { weekday: 'short', day: '2-digit', month: 'short' })
}
