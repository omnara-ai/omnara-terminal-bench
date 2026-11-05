import type { TrajectoryMetrics } from './atif'

export interface HarborTrial {
  run: string
  task: string
  trialName: string
  agentId: string | null
  reward: number | null
  exception: string | null
  stoppedMidTurn: boolean
  harborAgentSeconds: number | null
  trajectory: TrajectoryMetrics | null
  // The model refused at the end of every attempt; shown, but not graded.
  refused?: boolean
}

export interface HarborRun {
  run: string
  profileId: string
}

export interface HarborSnapshot {
  orgId: string
  projectId: string
  runs: HarborRun[]
  trials: HarborTrial[]
  excludedTasks?: string[]
}

export interface CodexTrial {
  id: string
  task: string
  trialName: string
  reward: number | null
  exception: string | null
  hubCostUsd: number | null
  trajectory: TrajectoryMetrics | null
}

export interface CodexSnapshot {
  jobId: string
  trials: CodexTrial[]
}

export interface AgentUsage {
  agentId: string
  name: string
  profileId: string | null
  createdAt: string
  modelCalls: number
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number | null
  callsWithReportedCost: number
}

// The model call behind one context checkpoint, recorded separately: its usage isn't a model_output event.
export interface Compaction {
  run: string
  task: string
  agentId: string
  checkpointId: string
  sequence: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface ViewInfo {
  id: string
  label: string
  baselineName: string
  model: string
  modelOnly?: boolean
}

export interface SummaryResponse {
  view: ViewInfo
  views: ViewInfo[]
  harbor: HarborSnapshot
  codex: CodexSnapshot
  agents: AgentUsage[]
  compactions?: Compaction[]
  appUrl: string
  apiError?: string
  omitted: OmittedTask[]
}

export interface OmittedTask {
  task: string
  reason: string
}
