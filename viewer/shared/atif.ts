export interface AtifToolCall {
  tool_call_id: string
  function_name: string
  arguments?: unknown
}

export interface AtifStep {
  step_id: number | string
  timestamp?: string
  source: 'system' | 'user' | 'agent'
  message?: string
  reasoning_content?: string
  llm_call_count?: number | string
  tool_calls?: AtifToolCall[]
  observation?: { results?: { source_call_id?: string; content?: unknown }[] }
  metrics?: {
    prompt_tokens?: number | null
    completion_tokens?: number | null
    cached_tokens?: number | null
    cost_usd?: number | null
  }
}

export interface AtifTrajectory {
  schema_version?: string
  agent?: { name?: string; version?: string; model_name?: string }
  steps: AtifStep[]
  final_metrics?: {
    total_prompt_tokens?: number | null
    total_completion_tokens?: number | null
    total_cached_tokens?: number | null
    total_cost_usd?: number | null
    extra?: { reasoning_output_tokens?: number | null }
  }
}

export interface TrajectoryMetrics {
  modelCalls: number
  toolCalls: number
  agentSeconds: number | null
  inputTokens: number
  cachedTokens: number
  outputTokens: number
  reasoningTokens: number | null
  costUsd: number | null
}

export function trajectoryMetrics(trajectory: AtifTrajectory): TrajectoryMetrics {
  let modelCalls = 0
  let toolCalls = 0
  let first = Infinity
  let last = -Infinity
  for (const step of trajectory.steps) {
    if (step.source === 'agent') {
      modelCalls += step.llm_call_count === undefined ? 1 : Number(step.llm_call_count)
      toolCalls += step.tool_calls?.length ?? 0
    }
    const at = step.timestamp ? Date.parse(step.timestamp) : NaN
    if (Number.isFinite(at)) {
      first = Math.min(first, at)
      last = Math.max(last, at)
    }
  }
  const totals = trajectory.final_metrics ?? {}
  return {
    modelCalls,
    toolCalls,
    agentSeconds: Number.isFinite(first) ? (last - first) / 1000 : null,
    inputTokens: totals.total_prompt_tokens ?? 0,
    cachedTokens: totals.total_cached_tokens ?? 0,
    outputTokens: totals.total_completion_tokens ?? 0,
    reasoningTokens: totals.extra?.reasoning_output_tokens ?? null,
    costUsd: totals.total_cost_usd ?? null,
  }
}
