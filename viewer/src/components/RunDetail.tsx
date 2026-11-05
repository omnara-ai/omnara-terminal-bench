import type { AgentEvent } from '@omnara/sdk'
import { useEffect, useState } from 'react'

import type { AtifTrajectory } from '../../shared/atif'
import type { Run } from '../../shared/compare'
import { type Span, type Timeline, timelineFromAtif, timelineFromEvents } from '../../shared/trace'
import { useBaselineName } from '../baseline'
import { compact, duration, usd } from '../format'
import { Conversation } from './Conversation'
import { Harness, OutcomeBadge } from './bits'
import { Trace } from './Trace'

async function loadTimeline(run: Run): Promise<Timeline> {
  const url =
    run.harness === 'omnara'
      ? `/api/agents/${run.agentId}/events`
      : `/api/codex/trials/${run.trialId}/trajectory`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return run.harness === 'omnara'
    ? timelineFromEvents((await response.json()) as AgentEvent[])
    : timelineFromAtif((await response.json()) as AtifTrajectory)
}

interface Props {
  run: Run
  projectUrl: string
  jobId: string
  onClose: () => void
}

export function RunDetail({ run, projectUrl, jobId, onClose }: Props) {
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<Span | null>(null)

  useEffect(() => {
    let live = true
    setTimeline(null)
    setError(null)
    setSelected(null)
    if (run.harness === 'omnara' && !run.agentId) {
      setError('This trial has no Omnara agent id.')
      return
    }
    loadTimeline(run).then(
      (t) => live && setTimeline(t),
      (e: unknown) => live && setError(String(e)),
    )
    return () => {
      live = false
    }
  }, [run])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])

  const baseline = useBaselineName()
  const m = run.metrics
  const external =
    run.harness === 'omnara'
      ? { href: `${projectUrl}/agents/${run.agentId}`, label: 'Open in Omnara ↗' }
      : jobId
        ? { href: `https://hub.harborframework.com/jobs/${jobId}`, label: `${baseline} job on Harbor Hub ↗` }
        : null

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={`${run.task} ${run.trialName}`}>
        <div className="drawer-head">
          <div className="title">
            <Harness harness={run.harness} />
            <h2>
              {run.harness === 'omnara' ? `${run.run} · ` : ''}
              {run.trialName}
            </h2>
            <OutcomeBadge run={run} />
            {run.exception && <span className="tag">{run.exception}</span>}
            <button type="button" className="close" onClick={onClose}>
              Close
            </button>
          </div>
          <div className="facts num">
            <span>
              Cost <b>{usd(m.costUsd)}</b>
              {run.harness === 'omnara' && run.compaction.calls > 0 && (
                <> (incl. {usd(run.compaction.costUsd)} compaction)</>
              )}
            </span>
            <span>
              Agent time <b>{duration(m.agentSeconds)}</b>
            </span>
            {run.harness === 'omnara' && run.harborAgentSeconds !== null && (
              <span title="Harbor's agent_execution: until the agent finished or was cancelled">
                Harbor wall time <b>{duration(run.harborAgentSeconds)}</b>
              </span>
            )}
            <span>
              Model calls <b>{compact(m.modelCalls)}</b>
              {run.harness === 'omnara' && run.compaction.calls > 0 && (
                <> (incl. {run.compaction.calls} compaction)</>
              )}
            </span>
            <span>
              Input <b>{compact(m.inputTokens)}</b> ({compact(m.cachedTokens)} cached)
            </span>
            <span>
              Output <b>{compact(m.outputTokens)}</b>
            </span>
            {external && (
              <span className="links">
                <a href={external.href} target="_blank" rel="noreferrer">
                  {external.label}
                </a>
              </span>
            )}
          </div>
        </div>
        {error && <div className="status-msg">Couldn't load this run: {error}</div>}
        {!error && !timeline && <div className="status-msg">Loading the run…</div>}
        {timeline && (
          <div className="drawer-body">
            <Trace timeline={timeline} selected={selected} onSelect={setSelected} />
            <Conversation timeline={timeline} focus={selected?.messageId ?? null} />
          </div>
        )}
      </aside>
    </>
  )
}
