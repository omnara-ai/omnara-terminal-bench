export const usd = (n: number | null) =>
  n === null ? '—' : n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`

export function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function compact(n: number | null): string {
  if (n === null) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 1 : 2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return abs < 10 && !Number.isInteger(n) ? n.toFixed(1) : String(Math.round(n))
}

export const percent = (n: number | null, digits = 1) => (n === null ? '—' : `${(n * 100).toFixed(digits)}%`)

// Cuts to one decimal instead of rounding, so 58.97% reads 58.9%, not 59.0%
export const percentTruncated = (n: number | null) =>
  n === null ? '—' : `${(Math.floor(n * 1000 + 1e-9) / 10).toFixed(1)}%`

export const ms = (n: number) => (n < 1000 ? `${Math.round(n)}ms` : duration(n / 1000))
