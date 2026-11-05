import type { TrajectoryMetrics } from './atif'
import type { AgentUsage, CodexTrial, HarborTrial, SummaryResponse } from './types'

export type Outcome = 'pass' | 'fail' | 'error' | 'refused' | 'ungraded'
export const SURCHARGE = 1.05

export const METRIC_KEYS = [
  'costUsd',
  'agentSeconds',
  'modelCalls',
  'toolCalls',
  'totalTokens',
  'inputTokens',
  'cachedTokens',
  'outputTokens',
] as const
export type MetricKey = (typeof METRIC_KEYS)[number]
export type Metrics = Record<MetricKey, number | null>

interface RunBase {
  key: string
  task: string
  trialName: string
  outcome: Outcome
  exception: string | null
  metrics: Metrics
}

export interface OmnaraRun extends RunBase {
  harness: 'omnara'
  run: string
  agentId: string | null
  stoppedMidTurn: boolean
  harborAgentSeconds: number | null
  usageSource: 'api' | 'trajectory'
  compaction: CompactionTotals
}

export interface CompactionTotals {
  calls: number
  costUsd: number
  inputTokens: number
  outputTokens: number
}
const NO_COMPACTION: CompactionTotals = { calls: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 }

export interface CodexRun extends RunBase {
  harness: 'codex'
  trialId: string
}

export type Run = OmnaraRun | CodexRun

export interface Stats {
  graded: number
  passes: number
  errors: number
  ungraded: number
  passRate: number | null
  mean: Metrics
}

export interface TaskRow {
  task: string
  omnara: OmnaraRun[]
  codex: CodexRun[]
  omnaraStats: Stats
  codexStats: Stats
}

export interface Comparison {
  tasks: TaskRow[]
  commonTasks: number
  omnara: Stats
  codex: Stats
  codexAllTasks: Stats
  codexOnlyTasks: string[]
}

export function outcomeOf(reward: number | null, exception: string | null, refused = false): Outcome {
  if (refused) return 'refused'
  if (reward === 1) return 'pass'
  if (reward !== null) return 'fail'
  return exception ? 'error' : 'ungraded'
}

function fromTrajectory(t: TrajectoryMetrics | null): Metrics {
  return {
    costUsd: t?.costUsd ?? null,
    agentSeconds: t?.agentSeconds ?? null,
    modelCalls: t?.modelCalls ?? null,
    toolCalls: t?.toolCalls ?? null,
    totalTokens: t ? t.inputTokens + t.outputTokens : null,
    inputTokens: t?.inputTokens ?? null,
    cachedTokens: t?.cachedTokens ?? null,
    outputTokens: t?.outputTokens ?? null,
  }
}

function omnaraMetrics(trial: HarborTrial | null, usage: AgentUsage | undefined, compaction = NO_COMPACTION) {
  const metrics = fromTrajectory(trial?.trajectory ?? null)
  if (!usage || usage.modelCalls === 0) {
    // Trajectories count model_output events only, so compaction calls are added on top.
    const add = (value: number | null, extra: number) => (value === null ? null : value + extra)
    return {
      usageSource: 'trajectory' as const,
      compaction,
      metrics: {
        ...metrics,
        costUsd: add(metrics.costUsd, compaction.costUsd),
        modelCalls: add(metrics.modelCalls, compaction.calls),
        totalTokens: add(metrics.totalTokens, compaction.inputTokens + compaction.outputTokens),
        inputTokens: add(metrics.inputTokens, compaction.inputTokens),
        outputTokens: add(metrics.outputTokens, compaction.outputTokens),
      },
    }
  }
  return {
    usageSource: 'api' as const,
    compaction: NO_COMPACTION,
    metrics: {
      ...metrics,
      costUsd: usage.costUsd !== null ? usage.costUsd / SURCHARGE : metrics.costUsd,
      modelCalls: usage.modelCalls,
      totalTokens: usage.inputTokens + usage.outputTokens,
      inputTokens: usage.inputTokens,
      cachedTokens: usage.cachedTokens,
      outputTokens: usage.outputTokens,
    },
  }
}

export function trialFromAgentName(name: string): { trialName: string; task: string } | null {
  const trialName = name.split(' · ').at(-1) ?? ''
  const task = trialName.split('__')[0]
  return trialName.includes('__') && task ? { trialName, task } : null
}

export function stats(runs: readonly Run[]): Stats {
  const graded = runs.filter((r) => r.outcome !== 'ungraded' && r.outcome !== 'refused')
  const passes = graded.filter((r) => r.outcome === 'pass').length
  const mean = Object.fromEntries(
    METRIC_KEYS.map((key) => {
      const values = graded.map((r) => r.metrics[key]).filter((v): v is number => v !== null)
      return [key, values.length ? values.reduce((a, b) => a + b, 0) / values.length : null]
    }),
  ) as Metrics
  return {
    graded: graded.length,
    passes,
    errors: graded.filter((r) => r.outcome === 'error').length,
    ungraded: runs.filter((r) => r.outcome === 'ungraded').length,
    passRate: graded.length ? passes / graded.length : null,
    mean,
  }
}

export function compare(summary: SummaryResponse): Comparison {
  const usageByAgent = new Map(summary.agents.map((a) => [a.agentId, a]))
  const runByProfile = new Map(summary.harbor.runs.map((r) => [r.profileId, r.run]))
  const compactionByAgent = new Map<string, CompactionTotals>()
  for (const c of summary.compactions ?? []) {
    const totals = compactionByAgent.get(c.agentId) ?? { ...NO_COMPACTION }
    totals.calls += 1
    totals.costUsd += c.costUsd
    totals.inputTokens += c.inputTokens
    totals.outputTokens += c.outputTokens
    compactionByAgent.set(c.agentId, totals)
  }
  const omnara: OmnaraRun[] = summary.harbor.trials.map((trial) => ({
    harness: 'omnara',
    key: `${trial.run}/${trial.trialName}`,
    run: trial.run,
    task: trial.task,
    trialName: trial.trialName,
    agentId: trial.agentId,
    outcome: outcomeOf(trial.reward, trial.exception, trial.refused),
    exception: trial.exception,
    stoppedMidTurn: trial.stoppedMidTurn,
    harborAgentSeconds: trial.harborAgentSeconds,
    ...omnaraMetrics(
      trial,
      trial.agentId ? usageByAgent.get(trial.agentId) : undefined,
      trial.agentId ? compactionByAgent.get(trial.agentId) : undefined,
    ),
  }))

  const graded = new Set(summary.harbor.trials.map((t) => t.agentId))
  const snapshotTasks = new Set(summary.harbor.trials.map((t) => t.task))
  for (const agent of summary.agents) {
    const parsed = trialFromAgentName(agent.name)
    if (graded.has(agent.agentId) || !parsed || !snapshotTasks.has(parsed.task)) continue
    omnara.push({
      harness: 'omnara',
      key: agent.agentId,
      run: runByProfile.get(agent.profileId ?? '') ?? '?',
      task: parsed.task,
      trialName: parsed.trialName,
      agentId: agent.agentId,
      outcome: 'ungraded',
      exception: null,
      stoppedMidTurn: false,
      harborAgentSeconds: null,
      ...omnaraMetrics(null, agent, compactionByAgent.get(agent.agentId)),
    })
  }

  const codex: CodexRun[] = summary.codex.trials.map((trial: CodexTrial) => {
    const metrics = fromTrajectory(trial.trajectory)
    metrics.costUsd ??= trial.hubCostUsd
    return {
      harness: 'codex',
      key: trial.id,
      trialId: trial.id,
      task: trial.task,
      trialName: trial.trialName,
      outcome: outcomeOf(trial.reward, trial.exception),
      exception: trial.exception,
      metrics,
    }
  })

  const byRun = (a: Run, b: Run) =>
    (a.harness === 'omnara' && b.harness === 'omnara' ? a.run.localeCompare(b.run) : 0) ||
    a.trialName.localeCompare(b.trialName)
  const omnaraTasks = [...new Set(omnara.map((r) => r.task))].sort()
  const tasks: TaskRow[] = omnaraTasks.map((task) => {
    const o = omnara.filter((r) => r.task === task).sort(byRun)
    const c = codex.filter((r) => r.task === task).sort(byRun)
    return { task, omnara: o, codex: c, omnaraStats: stats(o), codexStats: stats(c) }
  })
  const common = new Set(tasks.filter((t) => t.codex.length > 0).map((t) => t.task))

  return {
    tasks,
    commonTasks: common.size,
    omnara: stats(omnara.filter((r) => common.has(r.task))),
    codex: stats(codex.filter((r) => common.has(r.task))),
    codexAllTasks: stats(codex),
    codexOnlyTasks: [...new Set(codex.map((r) => r.task))].filter((t) => !omnaraTasks.includes(t)).sort(),
  }
}

export function ratio(omnara: number | null, codex: number | null): number | null {
  return omnara === null || codex === null || codex === 0 ? null : omnara / codex
}
