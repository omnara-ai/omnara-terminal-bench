import { Fragment, useMemo, useState } from 'react'

import { type Comparison, type MetricKey, ratio, type Run, type TaskRow } from '../../shared/compare'
import { useBaselineName } from '../baseline'
import { compact, duration, usd } from '../format'
import { Dots, Harness, OutcomeBadge, Ratio } from './bits'

const METRICS: { key: MetricKey; label: string; format: (n: number | null) => string }[] = [
  { key: 'costUsd', label: 'Cost', format: usd },
  { key: 'agentSeconds', label: 'Agent time', format: duration },
  { key: 'modelCalls', label: 'Model calls', format: compact },
  { key: 'totalTokens', label: 'Tokens', format: compact },
]

type SortKey = 'task' | 'pass' | MetricKey
const sorters: Record<string, (t: TaskRow) => number | string> = {
  task: (t) => t.task,
  pass: (t) => (t.omnaraStats.passRate ?? 0) - (t.codexStats.passRate ?? 0),
}
const sortValue = (t: TaskRow, key: SortKey) =>
  sorters[key]?.(t) ?? ratio(t.omnaraStats.mean[key as MetricKey], t.codexStats.mean[key as MetricKey]) ?? Infinity

export function TaskTable({ comparison, onOpen }: { comparison: Comparison; onOpen: (run: Run) => void }) {
  const baseline = useBaselineName()
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'task', dir: 1 })
  const [open, setOpen] = useState<Set<string>>(new Set())

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return comparison.tasks
      .filter((t) => !q || t.task.includes(q))
      .sort((a, b) => {
        const [x, y] = [sortValue(a, sort.key), sortValue(b, sort.key)]
        return (x < y ? -1 : x > y ? 1 : a.task.localeCompare(b.task)) * sort.dir
      })
  }, [comparison, query, sort])

  const toggle = (task: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(task)) next.delete(task)
      else next.add(task)
      return next
    })

  const header = (key: SortKey, label: string, title?: string, right = false) => (
    <th className={right ? 'r' : undefined} title={title} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (-s.dir as 1 | -1) : 1 }))}>
        {label} {sort.key === key ? (sort.dir === 1 ? '↑' : '↓') : ''}
      </button>
    </th>
  )

  return (
    <section className="tasks-section">
      <div className="table-head">
        <h2>Tasks</h2>
        <div className="legend" style={{ marginTop: 0 }}>
          <span>
            <span className="dot pass" /> pass
          </span>
          <span>
            <span className="dot fail" /> fail
          </span>
          <span>
            <span className="dot error" /> error
          </span>
          <span>
            <span className="dot refused" /> refused
          </span>
          <span>
            <span className="dot ungraded" /> ungraded
          </span>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Filter tasks"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter tasks"
        />
      </div>
      <div className="table-wrap">
        <table className="tasks">
          <thead>
            <tr>
              {header('task', `Task (${rows.length})`)}
              {header('pass', 'Passes', `Sort by Omnara pass rate minus ${baseline} pass rate`)}
              {METRICS.map((m) => (
                <Fragment key={m.key}>{header(m.key, m.label, `Sort by Omnara ÷ ${baseline}`, true)}</Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isOpen = open.has(row.task)
              return (
                <Fragment key={row.task}>
                  <tr className={`task-row${isOpen ? ' open' : ''}`} onClick={() => toggle(row.task)}>
                    <td>
                      <span className="task-name">
                        <span className="chevron">▸</span>
                        {row.task}
                      </span>
                    </td>
                    <td>
                      <div className="passcell">
                        <div className="line">
                          <span className="swatch omnara" />
                          <span className="count num">
                            {row.omnaraStats.passes}/{row.omnaraStats.graded}
                          </span>
                          <Dots runs={row.omnara} />
                        </div>
                        <div className="line">
                          <span className="swatch codex" />
                          <span className="count num">
                            {row.codexStats.passes}/{row.codexStats.graded}
                          </span>
                          <Dots runs={row.codex} />
                        </div>
                      </div>
                    </td>
                    {METRICS.map(({ key, format }) => (
                      <td className="r" key={key}>
                        <div className="pair num">
                          <span className="o">{format(row.omnaraStats.mean[key])}</span>
                          <span className="c">{format(row.codexStats.mean[key])}</span>
                          <Ratio omnara={row.omnaraStats.mean[key]} codex={row.codexStats.mean[key]} />
                        </div>
                      </td>
                    ))}
                  </tr>
                  {isOpen && (
                    <tr>
                      <td className="runs-cell" colSpan={2 + METRICS.length}>
                        <RunsTable row={row} onOpen={onOpen} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function RunsTable({ row, onOpen }: { row: TaskRow; onOpen: (run: Run) => void }) {
  const baseline = useBaselineName()
  const groups: [string, Run[]][] = [
    ['Omnara', row.omnara],
    [baseline, row.codex],
  ]
  return (
    <table className="runs">
      <thead>
        <tr>
          <th style={{ paddingLeft: 36 }}>Run</th>
          <th>Outcome</th>
          <th className="r">Cost</th>
          <th className="r">Agent time</th>
          <th className="r">Model calls</th>
          <th className="r">Input (cached)</th>
          <th className="r">Output</th>
        </tr>
      </thead>
      <tbody>
        {groups.map(([label, runs]) => (
          <Fragment key={label}>
            <tr className="group">
              <td colSpan={7}>
                <span className="group-label">{label}</span>
              </td>
            </tr>
            {runs.length === 0 && (
              <tr>
                <td colSpan={7} className="muted" style={{ paddingLeft: 36 }}>
                  None
                </td>
              </tr>
            )}
            {runs.map((run) => (
              <tr key={run.key} className="run" onClick={() => onOpen(run)} title="Open the conversation and trace">
                <td style={{ paddingLeft: 36 }}>
                  <Harness harness={run.harness} />
                  <span className="mono" style={{ marginLeft: 8 }}>
                    {run.harness === 'omnara' ? run.run : ''} {run.trialName}
                  </span>
                </td>
                <td>
                  <OutcomeBadge run={run} />
                  {run.exception && <span className="tag">{run.exception}</span>}
                  {run.harness === 'omnara' && run.stoppedMidTurn && run.outcome !== 'refused' && (
                    <span className="tag" title="The last model output didn't end the turn: the agent was cancelled or hit Harbor's timeout">
                      ended mid-turn
                    </span>
                  )}
                </td>
                <td className="r num">{usd(run.metrics.costUsd)}</td>
                <td className="r num">
                  {duration(run.metrics.agentSeconds)}
                  {run.harness === 'omnara' &&
                    run.harborAgentSeconds !== null &&
                    run.harborAgentSeconds - (run.metrics.agentSeconds ?? 0) > 600 && (
                      <div className="muted" style={{ fontSize: 11 }} title="Harbor's agent wall time: a tool call hung after the last model call">
                        wall {duration(run.harborAgentSeconds)}
                      </div>
                    )}
                </td>
                <td className="r num">{compact(run.metrics.modelCalls)}</td>
                <td className="r num">
                  {compact(run.metrics.inputTokens)} <span className="muted">({compact(run.metrics.cachedTokens)})</span>
                </td>
                <td className="r num">{compact(run.metrics.outputTokens)}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
