// Small white/simple UI kit used across every page.
// Tailwind classes only; no extra component libraries.

const cx = (...c) => c.filter(Boolean).join(' ')

const VARIANTS = {
  primary: 'bg-brand text-white active:bg-brand-dark disabled:bg-slate-300',
  secondary: 'bg-white text-slate-800 border border-slate-300 active:bg-slate-100 disabled:text-slate-500',
  danger: 'bg-red-600 text-white active:bg-red-700 disabled:bg-red-300',
  ghost: 'bg-transparent text-brand active:bg-brand-light disabled:text-slate-500'
}

const SIZES = {
  md: 'h-12 px-4 text-base',
  sm: 'h-9 px-3 text-sm',
  lg: 'h-14 px-5 text-lg'
}

export function Button({ variant = 'primary', size = 'md', full, className = '', children, ...props }) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-colors select-none',
        'disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-brand/40',
        VARIANTS[variant],
        SIZES[size],
        full && 'w-full',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

export function Card({ className = '', children, ...props }) {
  return (
    <div className={cx('rounded-2xl bg-white border border-slate-200 shadow-sm', className)} {...props}>
      {children}
    </div>
  )
}

export function Field({ label, hint, error, required, children }) {
  return (
    <label className="block">
      {label && (
        <span className="mb-1 block text-sm font-medium text-slate-700">
          {label} {required && <span className="text-red-500">*</span>}
        </span>
      )}
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-500">{error}</span>}
    </label>
  )
}

const inputBase =
  'w-full rounded-xl border border-slate-300 bg-white px-3.5 h-12 text-slate-900 placeholder:text-slate-500 ' +
  'focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:bg-slate-100'

export function TextInput({ className = '', ...props }) {
  return <input className={cx(inputBase, className)} {...props} />
}

export function NumberInput({ className = '', ...props }) {
  return <input inputMode="decimal" type="number" className={cx(inputBase, className)} {...props} />
}

export function TextArea({ className = '', rows = 3, ...props }) {
  return (
    <textarea
      rows={rows}
      className={cx(inputBase, 'h-auto py-3 leading-relaxed', className)}
      {...props}
    />
  )
}

export function Select({ className = '', children, ...props }) {
  return (
    <div className="relative">
      <select className={cx(inputBase, 'appearance-none pr-9', className)} {...props}>
        {children}
      </select>
      {/* visible drop-down arrow */}
      <svg
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
  )
}

const BADGE_COLORS = {
  slate: 'bg-slate-100 text-slate-600',
  green: 'bg-green-100 text-green-700',
  amber: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
  blue: 'bg-brand-light text-brand-dark'
}

export function Badge({ color = 'slate', className = '', children }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', BADGE_COLORS[color], className)}>
      {children}
    </span>
  )
}

export function Spinner({ className = '' }) {
  return (
    <svg className={cx('animate-spin h-5 w-5 text-current', className)} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  )
}

export function EmptyState({ title, subtitle, action }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="text-base font-medium text-slate-700">{title}</p>
      {subtitle && <p className="mt-1 max-w-xs text-sm text-slate-500">{subtitle}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function Modal({ open, onClose, title, children }) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90dvh] w-full max-w-app overflow-y-auto rounded-t-2xl bg-white p-4 pb-6 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h3 className="mb-3 text-base font-bold text-slate-800">{title}</h3>}
        {children}
      </div>
    </div>
  )
}

export function SectionTitle({ children, right }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{children}</h2>
      {right}
    </div>
  )
}
