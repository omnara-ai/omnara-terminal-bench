import { useMemo, useState } from 'react'

import { type Interval, type Measure, pairedBootstrap, type PairedEstimate } from '../../shared/bootstrap'
import type { Comparison } from '../../shared/compare'
import { useBaselineName } from '../baseline'
import { compact, duration, percentTruncated, usd } from '../format'

interface Row {
  measure: Measure
  name: string
  noun: string
  format: (n: number) => string
  higherIsBetter: boolean | null
}

const ROWS: Row[] = [
  { measure: 'passRate', name: 'Pass rate', noun: 'pass rate', format: percentTruncated, higherIsBetter: true },
  { measure: 'costUsd', name: 'Cost', noun: 'cost per task', format: usd, higherIsBetter: false },
  { measure: 'agentSeconds', name: 'Agent time', noun: 'time', format: duration, higherIsBetter: false },
  { measure: 'totalTokens', name: 'Tokens', noun: 'tokens', format: compact, higherIsBetter: false },
  { measure: 'outputTokens', name: 'Output tokens', noun: 'output tokens', format: compact, higherIsBetter: false },
]

const AXIS_MIN = 0.5
const AXIS_MAX = 2
const TICKS = [0.5, 0.75, 1, 1.5, 2]
const x = (r: number) =>
  (Math.log(Math.min(Math.max(r, AXIS_MIN), AXIS_MAX) / AXIS_MIN) / Math.log(AXIS_MAX / AXIS_MIN)) * 100

const range = (i: Interval, format: (n: number) => string) => `${format(i.lo)}–${format(i.hi)}`
const change = (ratio: number) => {
  const pct = Math.round((ratio - 1) * 100)
  return pct === 0 ? '0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`
}

function difference(e: PairedEstimate, row: Row) {
  const r = e.ratio
  if (!r) return null
  const clear = r.lo > 1 || r.hi < 1
  const tone = !clear ? 'same' : row.higherIsBetter === null ? 'neutral' : r.lo > 1 === row.higherIsBetter ? 'better' : 'worse'
  return {
    tone,
    text: clear ? `${change(r.estimate)} ${row.noun}` : 'No clear difference',
    ci: `${change(r.lo)} to ${change(r.hi)}`,
  }
}

const LEVELS = [0.9, 0.95, 0.99]
const LEVEL_KEY = 'tb-viewer:ci-level'

function savedLevel() {
  try {
    const saved = Number(localStorage.getItem(LEVEL_KEY))
    return LEVELS.includes(saved) ? saved : LEVELS[0]!
  } catch {
    return LEVELS[0]!
  }
}

export function Summary({ comparison }: { comparison: Comparison }) {
  const baseline = useBaselineName()
  const { omnara, codex, tasks } = comparison
  const [level, setLevel] = useState(savedLevel)
  const choose = (next: number) => {
    setLevel(next)
    try {
      localStorage.setItem(LEVEL_KEY, String(next))
    } catch {
    }
  }
  const ci = `${Math.round(level * 100)}% CI`
  const common = useMemo(() => tasks.filter((t) => t.codex.length > 0), [tasks])
  const estimates = useMemo(
    () => new Map(ROWS.map((row) => [row.measure, pairedBootstrap(common, row.measure, { level })])),
    [common, level],
  )
  const pass = estimates.get('passRate')
  const points = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}`

  return (
    <section className="summary">
      <div className="headline">
        <div className="headline-figures">
          <div className="figure">
            <span className="label">
              <span className="swatch omnara" /> Omnara
            </span>
            <span className="value">{percentTruncated(omnara.passRate)}</span>
            <span className="sub num">
              {omnara.passes}/{omnara.graded} trials
            </span>
          </div>
          <span className="vs">vs</span>
          <div className="figure">
            <span className="label">
              <span className="swatch codex" /> {baseline}
            </span>
            <span className="value">{percentTruncated(codex.passRate)}</span>
            <span className="sub num">
              {codex.passes}/{codex.graded} trials
            </span>
          </div>
        </div>
        {pass && (
          <p className="headline-text">
            <b className="num" title={`${ci} ${points(pass.diff.lo)} to ${points(pass.diff.hi)} pts`}>
              {points(pass.diff.estimate)} pts
            </b>
          </p>
        )}
        <div className="ci-level">
          <span>Confidence interval</span>
          <div className="segmented" role="group" aria-label="Confidence interval">
            {LEVELS.map((l) => (
              <button type="button" key={l} aria-pressed={l === level} onClick={() => choose(l)}>
                {Math.round(l * 100)}%
              </button>
            ))}
          </div>
        </div>
      </div>

      <div
        className="forest"
        role="table"
        aria-label={`Omnara vs ${baseline} per trial, with ${Math.round(level * 100)}% confidence intervals`}
      >
        <div className="forest-row forest-head" role="row">
          <span role="columnheader">Per trial</span>
          <span role="columnheader" className="r">
            <span className="swatch omnara" /> Omnara
          </span>
          <span role="columnheader" className="r">
            <span className="swatch codex" /> {baseline}
          </span>
          <span role="columnheader" className="forest-axis">
            {TICKS.map((t) => (
              <span
                key={t}
                style={{
                  left: `${x(t)}%`,
                  transform: t === AXIS_MIN ? 'none' : t === AXIS_MAX ? 'translateX(-100%)' : undefined,
                }}
              >
                {t}×
              </span>
            ))}
          </span>
          <span role="columnheader">Difference</span>
        </div>
        {ROWS.map((row) => {
          const e = estimates.get(row.measure)
          if (!e) return null
          const d = difference(e, row)
          const r = e.ratio
          return (
            <div className="forest-row" role="row" key={row.measure}>
              <span role="cell" className="metric">
                {row.name}
              </span>
              <span role="cell" className="r value-ci">
                <b className="num">{row.format(e.omnara.estimate)}</b>
                <span className="ci num">{range(e.omnara, row.format)}</span>
              </span>
              <span role="cell" className="r value-ci">
                <b className="num">{row.format(e.codex.estimate)}</b>
                <span className="ci num">{range(e.codex, row.format)}</span>
              </span>
              <span
                role="cell"
                className="forest-plot"
                title={r ? `${r.estimate.toFixed(2)}× (${ci} ${r.lo.toFixed(2)}–${r.hi.toFixed(2)})` : undefined}
              >
                <span className="ref" style={{ left: `${x(1)}%` }} />
                {r && (
                  <>
                    <span
                      className={`whisker ${d?.tone ?? 'same'}`}
                      style={{ left: `${x(r.lo)}%`, width: `${x(r.hi) - x(r.lo)}%` }}
                    />
                    <span className={`point ${d?.tone ?? 'same'}`} style={{ left: `${x(r.estimate)}%` }} />
                  </>
                )}
              </span>
              <span role="cell" className={`value-ci verdict ${d?.tone ?? 'same'}`}>
                <b className="num">{d?.text ?? '—'}</b>
                {d && <span className="ci num">{d.ci}</span>}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}
