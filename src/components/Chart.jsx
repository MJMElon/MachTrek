// Lightweight dependency-free SVG grouped BAR chart. 12 monthly groups, one
// coloured bar per series (operator). Hover a bar to see its label + value;
// click (or tap) a bar to copy the raw number to the clipboard. null values are
// "no data" and draw no bar.

import { useState } from 'react'
import { MONTH_LABELS } from '../lib/dashboard.js'

const W = 320
const H = 168
const PAD = { l: 34, r: 8, t: 10, b: 16 }
const plotW = W - PAD.l - PAD.r
const plotH = H - PAD.t - PAD.b

const groupW = plotW / 12
const niceMax = (v) => {
  if (!(v > 0)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}

export function BarChart({ title, series = [], unit = '', formatValue, thin = false }) {
  const [hover, setHover] = useState(null) // { i, si }
  const [copied, setCopied] = useState(null) // { i, si } — the bar just copied

  const fmt = formatValue || ((v) => trim(v))
  const allVals = series.flatMap((s) => s.values.filter((v) => v != null))
  const hasData = allVals.length > 0
  const max = niceMax(Math.max(0, ...allVals))
  const yFor = (v) => PAD.t + plotH * (1 - v / max)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f)

  const n = Math.max(1, series.length)
  const innerPad = groupW * 0.12
  const bandW = groupW - innerPad * 2
  // Each series gets a slot in the month band; the bar fills part of the slot so
  // there's a gap between workers (slimmer bars when `thin`).
  const slot = bandW / n
  const bw = Math.max(0.8, slot * (thin ? 0.45 : 0.9))
  const barX = (i, si) => PAD.l + groupW * i + innerPad + si * slot + (slot - bw) / 2

  const copy = async (v, i, si) => {
    try {
      await navigator.clipboard.writeText(String(v))
    } catch {
      /* clipboard unavailable (insecure context) — still show the confirmation */
    }
    setCopied({ i, si })
    setTimeout(() => setCopied((c) => (c && c.i === i && c.si === si ? null : c)), 1100)
  }

  const hv = hover ? series[hover.si]?.values[hover.i] : null

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5">
      {title && (
        <p className="mb-1 px-1 text-xs font-semibold text-slate-600">
          {title}
          {unit ? ` · ${unit}` : ''}
        </p>
      )}

      {hasData ? (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
            {/* gridlines + y labels */}
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.l} y1={yFor(t)} x2={W - PAD.r} y2={yFor(t)} stroke="#eef2f7" strokeWidth="1" />
                <text x={PAD.l - 3} y={yFor(t) + 3} textAnchor="end" fontSize="6" fill="#94a3b8">{trim(t)}</text>
              </g>
            ))}
            {/* month ticks */}
            {MONTH_LABELS.map((m, i) => (
              <text key={m} x={PAD.l + groupW * i + groupW / 2} y={H - 4} textAnchor="middle" fontSize="6" fill="#94a3b8">
                {m}
              </text>
            ))}
            {/* bars */}
            {series.map((s, si) =>
              s.values.map((v, i) => {
                if (v == null) return null
                const x = barX(i, si)
                const y = yFor(v)
                const h = Math.max(0, PAD.t + plotH - y)
                const on = hover && hover.i === i && hover.si === si
                return (
                  <rect
                    key={`${si}-${i}`}
                    x={x}
                    y={y}
                    width={bw}
                    height={h}
                    fill={s.color}
                    opacity={hover && !on ? 0.45 : 1}
                    className="cursor-pointer"
                    onMouseEnter={() => setHover({ i, si })}
                    onMouseLeave={() => setHover((p) => (p && p.i === i && p.si === si ? null : p))}
                    onClick={() => copy(v, i, si)}
                  />
                )
              })
            )}
          </svg>

          {hover && hv != null && !(copied && copied.i === hover.i && copied.si === hover.si) && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
              style={{
                left: `${((barX(hover.i, hover.si) + bw / 2) / W) * 100}%`,
                top: `${(yFor(hv) / H) * 100}%`
              }}
            >
              {series[hover.si].name}: {fmt(hv)}
            </div>
          )}

          {/* "Copied ✓" pops up just above the copied bar, then fades out */}
          {copied && series[copied.si]?.values[copied.i] != null && (
            <div
              className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
              style={{
                left: `${((barX(copied.i, copied.si) + bw / 2) / W) * 100}%`,
                top: `${(yFor(series[copied.si].values[copied.i]) / H) * 100}%`
              }}
            >
              Copied ✓
            </div>
          )}
        </div>
      ) : (
        <p className="px-1 py-6 text-center text-xs text-slate-500">No data</p>
      )}

      {/* legend */}
      {hasData && series.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 px-1">
          {series.map((s, i) => (
            <span key={i} className="flex items-center gap-1 text-[11px] text-slate-500">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {hasData && <p className="mt-0.5 px-1 text-[10px] text-slate-300">Tap a bar to copy its value</p>}
    </div>
  )
}

// Dependency-free SVG STACKED AREA chart. 12 monthly points; series are stacked
// bottom-to-top in array order (series[0] sits on the baseline, each later one
// rides on the one below). Every data point is a marker — hover to see its
// label + value, tap/click to copy the raw (non-cumulative) number. Values are
// plain numbers (0 = no work that month), never null.
export function StackedAreaChart({ title, series = [], unit = '', formatValue }) {
  const [hover, setHover] = useState(null) // { i, si }
  const [copied, setCopied] = useState(null) // { i, si } — the point just copied

  const fmt = formatValue || ((v) => trim(v))
  const N = 12

  // Cumulative tops: tops[si][i] = sum of series[0..si].values[i].
  const tops = []
  series.forEach((s, si) => {
    tops[si] = Array.from({ length: N }, (_, i) => {
      const below = si > 0 ? tops[si - 1][i] : 0
      return below + (Number(s.values[i]) || 0)
    })
  })
  const topMost = tops.length ? tops[tops.length - 1] : []
  const hasData = series.some((s) => s.values.some((v) => (Number(v) || 0) > 0))
  const max = niceMax(Math.max(0, ...topMost))
  const yFor = (v) => PAD.t + plotH * (1 - v / max)
  const xFor = (i) => PAD.l + groupW * i + groupW / 2
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f)
  const baselineY = yFor(0)

  const copy = async (v, i, si) => {
    try {
      await navigator.clipboard.writeText(String(v))
    } catch {
      /* clipboard unavailable (insecure context) — still show the confirmation */
    }
    setCopied({ i, si })
    setTimeout(() => setCopied((c) => (c && c.i === i && c.si === si ? null : c)), 1100)
  }

  const hv = hover ? series[hover.si]?.values[hover.i] : null

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5">
      {title && (
        <p className="mb-1 px-1 text-xs font-semibold text-slate-600">
          {title}
          {unit ? ` · ${unit}` : ''}
        </p>
      )}

      {hasData ? (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
            {/* gridlines + y labels */}
            {ticks.map((t, i) => (
              <g key={i}>
                <line x1={PAD.l} y1={yFor(t)} x2={W - PAD.r} y2={yFor(t)} stroke="#eef2f7" strokeWidth="1" />
                <text x={PAD.l - 3} y={yFor(t) + 3} textAnchor="end" fontSize="6" fill="#94a3b8">{trim(t)}</text>
              </g>
            ))}
            {/* month ticks */}
            {MONTH_LABELS.map((m, i) => (
              <text key={m} x={xFor(i)} y={H - 4} textAnchor="middle" fontSize="6" fill="#94a3b8">{m}</text>
            ))}
            {/* stacked areas — bottom layer first */}
            {series.map((s, si) => {
              const top = tops[si].map((v, i) => `${xFor(i)},${yFor(v)}`)
              const below = si > 0 ? tops[si - 1] : null
              const bottom = (below
                ? below.map((v, i) => `${xFor(i)},${yFor(v)}`)
                : tops[si].map((_, i) => `${xFor(i)},${baselineY}`)
              ).reverse()
              return <polygon key={`a-${si}`} points={[...top, ...bottom].join(' ')} fill={s.color} fillOpacity="0.3" />
            })}
            {/* top stroke per layer */}
            {series.map((s, si) => (
              <polyline
                key={`l-${si}`}
                points={tops[si].map((v, i) => `${xFor(i)},${yFor(v)}`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            ))}
            {/* data-point markers (tap to copy) */}
            {series.map((s, si) =>
              tops[si].map((v, i) => {
                const on = hover && hover.i === i && hover.si === si
                return (
                  <g key={`m-${si}-${i}`}>
                    <circle cx={xFor(i)} cy={yFor(v)} r={on ? 3.2 : 2.2} fill={s.color} opacity={hover && !on ? 0.4 : 1} />
                    {/* larger transparent hit target for touch/click */}
                    <circle
                      cx={xFor(i)}
                      cy={yFor(v)}
                      r={7}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHover({ i, si })}
                      onMouseLeave={() => setHover((p) => (p && p.i === i && p.si === si ? null : p))}
                      onClick={() => copy(s.values[i], i, si)}
                    />
                  </g>
                )
              })
            )}
          </svg>

          {hover && hv != null && !(copied && copied.i === hover.i && copied.si === hover.si) && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
              style={{ left: `${(xFor(hover.i) / W) * 100}%`, top: `${(yFor(tops[hover.si][hover.i]) / H) * 100}%` }}
            >
              {series[hover.si].name}: {fmt(hv)}
            </div>
          )}

          {/* "Copied ✓" pops up just above the copied point, then fades out */}
          {copied && series[copied.si]?.values[copied.i] != null && (
            <div
              className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
              style={{ left: `${(xFor(copied.i) / W) * 100}%`, top: `${(yFor(tops[copied.si][copied.i]) / H) * 100}%` }}
            >
              Copied ✓
            </div>
          )}
        </div>
      ) : (
        <p className="px-1 py-6 text-center text-xs text-slate-500">No data</p>
      )}

      {/* legend */}
      {hasData && series.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 px-1">
          {series.map((s, i) => (
            <span key={i} className="flex items-center gap-1 text-[11px] text-slate-500">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {hasData && <p className="mt-0.5 px-1 text-[10px] text-slate-300">Tap a point to copy its value</p>}
    </div>
  )
}

function trim(v) {
  const num = Number(v) || 0
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100)
}
