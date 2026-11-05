import type { Outcome, Run } from '../../shared/compare'
import { ratio } from '../../shared/compare'
import { useBaselineName } from '../baseline'

export function Ratio({ omnara, codex }: { omnara: number | null; codex: number | null }) {
  const baseline = useBaselineName()
  const r = ratio(omnara, codex)
  if (r === null) return <span className="ratio same">—</span>
  const tone = r < 0.9 ? 'better' : r > 1.1 ? 'worse' : 'same'
  const arrow = r < 1 ? '▼' : r > 1 ? '▲' : ''
  return (
    <span className={`ratio ${tone}`} title={`Omnara ÷ ${baseline}`}>
      {arrow} {r.toFixed(2)}×
    </span>
  )
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: 'Pass',
  fail: 'Fail',
  error: 'Error',
  refused: 'Refused',
  ungraded: 'Ungraded',
}
const OUTCOME_ICON: Record<Outcome, string> = { pass: '✓', fail: '✕', error: '◆', refused: '⊘', ungraded: '○' }

export function OutcomeBadge({ run }: { run: Run }) {
  return (
    <span className={`badge ${run.outcome}`}>
      {OUTCOME_ICON[run.outcome]} {OUTCOME_LABEL[run.outcome]}
    </span>
  )
}

export function Dots({ runs }: { runs: readonly Run[] }) {
  return (
    <span className="dots">
      {runs.map((run) => (
        <span
          key={run.key}
          className={`dot ${run.outcome}`}
          title={`${run.harness === 'omnara' ? run.run : run.trialName}: ${OUTCOME_LABEL[run.outcome]}${
            run.exception ? ` (${run.exception})` : ''
          }`}
        />
      ))}
    </span>
  )
}

export function Harness({ harness }: { harness: Run['harness'] }) {
  const baseline = useBaselineName()
  return (
    <span className="harness">
      <span className={`swatch ${harness}`} />
      {harness === 'omnara' ? 'Omnara' : baseline}
    </span>
  )
}
