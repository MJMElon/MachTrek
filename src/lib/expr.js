// Safe arithmetic evaluator for the calculator-style Quantity field. Supports
// + - * /, parentheses, decimals and unary minus — via a tiny recursive-descent
// parser, NOT eval(). Returns a finite number, or null when the text isn't a
// valid complete expression (e.g. while it's still being typed).

function tokenize(s) {
  const tokens = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      // Skip any whitespace, incl. newlines — the Quantity field is multi-line.
      i++
      continue
    }
    if ('+-*/()'.includes(c)) {
      tokens.push(c)
      i++
      continue
    }
    const m = /^\d*\.?\d+/.exec(s.slice(i))
    if (!m) return null // unexpected character
    tokens.push(parseFloat(m[0]))
    i += m[0].length
  }
  return tokens
}

function parse(tokens) {
  let i = 0
  const peek = () => tokens[i]
  const next = () => tokens[i++]

  function expr() {
    let v = term()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const r = term()
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  function term() {
    let v = factor()
    while (peek() === '*' || peek() === '/') {
      const op = next()
      const r = factor()
      v = op === '*' ? v * r : v / r
    }
    return v
  }
  function factor() {
    const t = peek()
    if (t === '+') {
      next()
      return factor()
    }
    if (t === '-') {
      next()
      return -factor()
    }
    if (t === '(') {
      next()
      const v = expr()
      if (next() !== ')') throw new Error('paren')
      return v
    }
    if (typeof t === 'number') {
      next()
      return t
    }
    throw new Error('unexpected')
  }

  const v = expr()
  if (i !== tokens.length) throw new Error('trailing tokens')
  return v
}

/** Evaluate an arithmetic string → number, or null if invalid/empty. */
export function evalExpr(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  if (!/^[\d+\-*/().\s]+$/.test(s)) return null
  const tokens = tokenize(s)
  if (!tokens || !tokens.length) return null
  try {
    const v = parse(tokens)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** Tidy a number for display: round to 4 dp and drop trailing zeros. */
export function formatResult(n) {
  if (n == null || !Number.isFinite(n)) return ''
  return String(Math.round(n * 10000) / 10000)
}

/** True when the text is more than a plain number (worth saving as a formula). */
export function isExpression(input) {
  const v = evalExpr(input)
  if (v == null) return false
  const s = String(input ?? '').trim()
  return s !== formatResult(v) && s !== String(v)
}
