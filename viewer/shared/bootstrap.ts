import { type MetricKey, type Run, type TaskRow } from './compare'

export interface Interval {
  estimate: number
  lo: number
  hi: number
}

export interface PairedEstimate {
  omnara: Interval
  codex: Interval
  diff: Interval
  ratio: Interval | null
}

export type Measure = MetricKey | 'passRate'

function random(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function totals(runs: readonly Run[], measure: Measure): [number, number] {
  let sum = 0
  let n = 0
  for (const run of runs) {
    if (run.outcome === 'ungraded' || run.outcome === 'refused') continue
    const value = measure === 'passRate' ? (run.outcome === 'pass' ? 1 : 0) : run.metrics[measure]
    if (value === null) continue
    sum += value
    n++
  }
  return [sum, n]
}

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i)
  return sorted[lo]! + (sorted[Math.ceil(i)]! - sorted[lo]!) * (i - lo)
}

const interval = (estimate: number, samples: number[], level: number): Interval => {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b)
  const tail = (1 - level) / 2
  return sorted.length
    ? { estimate, lo: quantile(sorted, tail), hi: quantile(sorted, 1 - tail) }
    : { estimate, lo: estimate, hi: estimate }
}

export function pairedBootstrap(
  tasks: readonly TaskRow[],
  measure: Measure,
  { iterations = 2000, seed = 1, level = 0.95 } = {},
): PairedEstimate | null {
  const rows = tasks
    .map((t) => ({ o: totals(t.omnara, measure), c: totals(t.codex, measure) }))
    .filter((r) => r.o[1] > 0 && r.c[1] > 0)
  if (rows.length === 0) return null

  const mean = (pick: (r: (typeof rows)[number]) => [number, number], idx: Iterable<number>) => {
    let sum = 0
    let n = 0
    for (const i of idx) {
      const [s, k] = pick(rows[i]!)
      sum += s
      n += k
    }
    return sum / n
  }
  const all = rows.map((_, i) => i)
  const o = mean((r) => r.o, all)
  const c = mean((r) => r.c, all)

  const next = random(seed)
  const samples = { o: [] as number[], c: [] as number[], diff: [] as number[], ratio: [] as number[] }
  const pick = new Array<number>(rows.length)
  for (let b = 0; b < iterations; b++) {
    for (let i = 0; i < rows.length; i++) pick[i] = Math.floor(next() * rows.length)
    const bo = mean((r) => r.o, pick)
    const bc = mean((r) => r.c, pick)
    samples.o.push(bo)
    samples.c.push(bc)
    samples.diff.push(bo - bc)
    samples.ratio.push(bc === 0 ? NaN : bo / bc)
  }
  return {
    omnara: interval(o, samples.o, level),
    codex: interval(c, samples.c, level),
    diff: interval(o - c, samples.diff, level),
    ratio: c === 0 ? null : interval(o / c, samples.ratio, level),
  }
}
