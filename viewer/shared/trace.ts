import type { AgentEvent } from '@omnara/sdk'

import type { AtifTrajectory } from './atif'

export type MessageKind = 'system' | 'user' | 'assistant' | 'reasoning' | 'tool_call' | 'tool_result' | 'checkpoint'

export interface Message {
  id: string
  at: number
  kind: MessageKind
  text: string
  toolName?: string
  toolCallId?: string
  outcome?: string
}

export interface Span {
  id: string
  kind: 'agent' | 'model' | 'tool'
  name: string
  start: number
  end: number
  depth: number
  status: 'ok' | 'error' | 'unfinished'
  attributes: Record<string, string | number>
  messageId?: string
}

export interface Timeline {
  start: number
  end: number
  spans: Span[]
  messages: Message[]
  modelMs: number
  toolMs: number
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value, null, 2)

function parseInput(input: unknown): unknown {
  if (typeof input !== 'string') return input
  try {
    return JSON.parse(input)
  } catch {
    return input
  }
}

function preview(input: unknown): string {
  const value = parseInput(input)
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    const first = v.command ?? v.cmd ?? v.path ?? v.query ?? v.input
    if (typeof first === 'string') return first.split('\n')[0]!.slice(0, 120)
  }
  return text(value).replace(/\s+/g, ' ').slice(0, 120)
}

function union(intervals: [number, number][]): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let total = 0
  let [curStart, curEnd] = [-Infinity, -Infinity]
  for (const [s, e] of sorted) {
    if (s > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart
      ;[curStart, curEnd] = [s, e]
    } else curEnd = Math.max(curEnd, e)
  }
  if (curEnd > curStart) total += curEnd - curStart
  return total
}

function finish(spans: Span[], messages: Message[]): Timeline {
  const times = [...spans.flatMap((s) => [s.start, s.end]), ...messages.map((m) => m.at)]
  const start = times.length ? Math.min(...times) : 0
  const end = times.length ? Math.max(...times) : 0
  for (const span of spans) if (span.status === 'unfinished') span.end = Math.max(span.end, end)
  spans.sort((a, b) => a.start - b.start || (a.kind === 'model' ? -1 : b.kind === 'model' ? 1 : 0))
  const models = spans.filter((s) => s.kind === 'model')
  const tools = spans.filter((s) => s.kind === 'tool')
  spans.unshift({
    id: 'agent',
    kind: 'agent',
    name: 'agent',
    start,
    end,
    depth: 0,
    status: 'ok',
    attributes: { model_calls: models.length, tool_calls: tools.length },
  })
  return {
    start,
    end,
    spans,
    messages,
    modelMs: models.reduce((n, s) => n + (s.end - s.start), 0),
    toolMs: union(tools.map((s) => [s.start, s.end])),
  }
}

export function timelineFromEvents(events: readonly AgentEvent[]): Timeline {
  const spans: Span[] = []
  const messages: Message[] = []
  const toolSpans = new Map<string, Span>()
  let previousAt: number | null = null
  let calls = 0

  for (const event of events) {
    const at = Date.parse(event.created_at)
    switch (event.event_kind) {
      case 'agent_input': {
        const body = event.content_blocks
          .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
          .filter(Boolean)
          .join('\n')
        if (body || event.input_kind !== 'config_change') {
          messages.push({ id: event.id, at, kind: 'user', text: body || `(${event.input_kind})` })
        }
        break
      }
      case 'model_output': {
        calls++
        const usage = event.usage ?? {}
        const firstMessage = messages.length
        for (const [i, block] of event.content_blocks.entries()) {
          const id = `${event.id}:${i}`
          if (block.type === 'text') messages.push({ id, at, kind: 'assistant', text: block.text })
          else if (block.type === 'reasoning' && 'text' in block && block.text) {
            messages.push({ id, at, kind: 'reasoning', text: String(block.text) })
          } else if (block.type === 'tool_call') {
            messages.push({
              id,
              at,
              kind: 'tool_call',
              text: text(parseInput(block.input)),
              toolName: block.name,
              toolCallId: block.tool_call_id,
            })
            const span: Span = {
              id: block.tool_call_id,
              kind: 'tool',
              name: block.name,
              start: at,
              end: at,
              depth: 1,
              status: 'unfinished',
              attributes: { 'tool.input': preview(block.input) },
              messageId: id,
            }
            spans.push(span)
            toolSpans.set(block.tool_call_id, span)
          }
        }
        spans.push({
          id: event.id,
          kind: 'model',
          name: `model call ${calls}`,
          start: previousAt ?? at,
          end: at,
          depth: 1,
          status: 'ok',
          attributes: {
            stop_reason: event.stop_reason,
            'tokens.input': usage.input_tokens_total ?? 0,
            'tokens.cached': usage.cache_read_input_tokens ?? 0,
            'tokens.output': usage.output_tokens_total ?? 0,
            'tokens.reasoning': usage.reasoning_output_tokens ?? 0,
          },
          messageId: messages[firstMessage]?.id,
        })
        break
      }
      case 'tool_result': {
        const span = toolSpans.get(event.tool_call_id)
        if (span) {
          span.end = at
          span.status = event.outcome === 'succeeded' ? 'ok' : 'error'
          span.attributes['tool.outcome'] = event.outcome
        }
        messages.push({
          id: event.id,
          at,
          kind: 'tool_result',
          text: event.content_blocks
            .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : text('value' in b ? b.value : b)))
            .join('\n'),
          toolName: span?.name,
          toolCallId: event.tool_call_id,
          outcome: event.outcome,
        })
        break
      }
      case 'context_checkpoint':
        messages.push({ id: event.id, at, kind: 'checkpoint', text: event.summary })
        break
    }
    previousAt = at
  }
  return finish(spans, messages)
}

const WALL_TIME = /Wall time:? ([\d.]+) seconds/

export function timelineFromAtif(trajectory: AtifTrajectory): Timeline {
  const spans: Span[] = []
  const messages: Message[] = []
  const steps = trajectory.steps
  let previousAt: number | null = null
  let calls = 0

  for (const [index, step] of steps.entries()) {
    const at: number = step.timestamp ? Date.parse(step.timestamp) : (previousAt ?? 0)
    const id = `step-${step.step_id}`
    if (step.source !== 'agent') {
      messages.push({ id, at, kind: step.source, text: step.message ?? '' })
      previousAt = at
      continue
    }
    calls += step.llm_call_count === undefined ? 1 : Number(step.llm_call_count)
    const firstMessage = messages.length
    if (step.reasoning_content) messages.push({ id: `${id}:r`, at, kind: 'reasoning', text: step.reasoning_content })
    if (step.message) messages.push({ id: `${id}:m`, at, kind: 'assistant', text: step.message })
    const nextAt = steps.slice(index + 1).find((s) => s.timestamp)?.timestamp
    const next = nextAt ? Date.parse(nextAt) : at
    const results = new Map((step.observation?.results ?? []).map((r) => [r.source_call_id, text(r.content)]))
    const toolEnds: number[] = []
    for (const call of step.tool_calls ?? []) {
      const callId = `${id}:${call.tool_call_id}`
      messages.push({
        id: callId,
        at,
        kind: 'tool_call',
        text: text(call.arguments),
        toolName: call.function_name,
        toolCallId: call.tool_call_id,
      })
      const output = results.get(call.tool_call_id)
      const wall = output?.match(WALL_TIME)
      const end = wall ? Math.min(at + Number(wall[1]) * 1000, Math.max(next, at)) : next
      toolEnds.push(end)
      spans.push({
        id: callId,
        kind: 'tool',
        name: call.function_name,
        start: at,
        end,
        depth: 1,
        status: output === undefined ? 'unfinished' : 'ok',
        attributes: { 'tool.input': preview(call.arguments), ...(wall ? { 'tool.wall_s': Number(wall[1]) } : {}) },
        messageId: callId,
      })
      if (output !== undefined) {
        messages.push({
          id: `${callId}:result`,
          at: wall ? at + Number(wall[1]) * 1000 : next,
          kind: 'tool_result',
          text: output,
          toolName: call.function_name,
          toolCallId: call.tool_call_id,
        })
      }
    }
    const m = step.metrics ?? {}
    spans.push({
      id,
      kind: 'model',
      name: `model call ${calls}`,
      start: previousAt ?? at,
      end: at,
      depth: 1,
      status: 'ok',
      attributes: {
        'tokens.input': m.prompt_tokens ?? 0,
        'tokens.cached': m.cached_tokens ?? 0,
        'tokens.output': m.completion_tokens ?? 0,
        ...(m.cost_usd != null ? { cost_usd: Number(m.cost_usd.toFixed(5)) } : {}),
      },
      messageId: messages[firstMessage]?.id,
    })
    previousAt = Math.max(at, ...toolEnds)
  }
  return finish(spans, messages)
}
