import { useEffect, useMemo, useState } from 'react'

import { compare, type Run } from '../shared/compare'
import type { SummaryResponse } from '../shared/types'
import { BaselineName } from './baseline'
import { RunDetail } from './components/RunDetail'
import { Summary } from './components/Summary'
import { TaskTable } from './components/TaskTable'

function useHash(): [string, (value: string) => void] {
  const [hash, setHash] = useState(() => location.hash.slice(1))
  useEffect(() => {
    const onChange = () => setHash(location.hash.slice(1))
    addEventListener('hashchange', onChange)
    return () => removeEventListener('hashchange', onChange)
  }, [])
  const update = (value: string) => {
    if (value) location.hash = value
    else history.replaceState(null, '', location.pathname + location.search)
    setHash(value)
  }
  return [hash, update]
}

const runHash = (run: Run) => (run.harness === 'omnara' ? `omnara/${run.agentId ?? run.key}` : `codex/${run.trialId}`)

export function App() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [hash, setHash] = useHash()
  const view = new URLSearchParams(location.search).get('view') ?? ''

  useEffect(() => {
    fetch(`/api/summary?view=${encodeURIComponent(view)}`)
      .then(async (r) => (r.ok ? ((await r.json()) as SummaryResponse) : Promise.reject(new Error(await r.text()))))
      .then(setSummary, (e: unknown) => setError(String(e)))
  }, [view])

  const comparison = useMemo(() => (summary ? compare(summary) : null), [summary])
  const selected = useMemo(() => {
    if (!comparison || !hash) return null
    for (const task of comparison.tasks) {
      for (const run of [...task.omnara, ...task.codex]) if (runHash(run) === hash) return run
    }
    return null
  }, [comparison, hash])

  if (error) return <div className="page status-msg">Couldn't load the summary: {error}</div>
  if (!summary || !comparison) return <div className="page status-msg">Loading…</div>

  const { harbor, codex } = summary
  const baseline = summary.view.baselineName
  return (
    <BaselineName.Provider value={baseline}>
    <div className="page">
      <header className="top">
        <div>
          <h1>Omnara vs {baseline}</h1>
          <p>
            {summary.view.model}
            {!summary.view.modelOnly && (
              <>
                {' '}
                · Terminal-Bench 4.0 · {harbor.runs.length > 1 ? `${harbor.runs.length} runs × ` : ''}
                {comparison.tasks.length} tasks
              </>
            )}
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Comparison">
          {summary.views.map((v) => (
            <button
              type="button"
              key={v.id}
              data-label={v.label}
              aria-pressed={v.id === summary.view.id}
              onClick={() => {
                location.search = `?view=${v.id}`
              }}
            >
              {v.label}
            </button>
          ))}
        </div>
      </header>

      {summary.apiError && (
        <div className="card banner">
          Omnara API unreachable; showing trajectory usage. <span className="mono">{summary.apiError}</span>
        </div>
      )}

      <Summary comparison={comparison} />
      <TaskTable comparison={comparison} onOpen={(run) => setHash(runHash(run))} />
      {summary.omitted?.length > 0 && (
        <section className="omitted">
          <h2>Omitted tasks ({summary.omitted.length})</h2>
          {[...new Set(summary.omitted.map((o) => o.reason))].map((reason) => {
            const tasks = summary.omitted.filter((o) => o.reason === reason)
            return (
              <div key={reason}>
                <h3>
                  {reason} ({tasks.length})
                </h3>
                <ul>
                  {tasks.map((o) => (
                    <li key={o.task} className="mono">
                      {o.task}
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </section>
      )}

      {selected && (
        <RunDetail run={selected} projectUrl={`${summary.appUrl}/projects/${harbor.projectId}`} jobId={codex.jobId} onClose={() => setHash('')} />
      )}
    </div>
    </BaselineName.Provider>
  )
}
