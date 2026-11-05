import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import type { AgentEvent } from '@omnara/sdk'

import { pairedBootstrap } from './bootstrap'
import { compare, outcomeOf, trialFromAgentName } from './compare'
import { timelineFromEvents } from './trace'
import type { CodexSnapshot, Compaction, HarborSnapshot, SummaryResponse } from './types'

const load = <T>(name: string) => JSON.parse(readFileSync(new URL(`../data/${name}`, import.meta.url), 'utf8')) as T
const sol = { id: 'sol', label: 'GPT-6.1 Sol vs Codex', baselineName: 'Codex', model: 'GPT-6.1 Sol' }
const offline: SummaryResponse = {
  view: sol,
  views: [sol],
  harbor: load<HarborSnapshot>('omnara-gpt-max.json'),
  codex: load<CodexSnapshot>('codex.json'),
  agents: [],
  appUrl: 'https://app.omnara.com',
  omitted: [],
}

test('outcomes follow the leaderboard: exceptions without a reward are errors', () => {
  assert.equal(outcomeOf(1, null), 'pass')
  assert.equal(outcomeOf(0, 'AgentTimeoutError'), 'fail')
  assert.equal(outcomeOf(null, 'VerifierTimeoutError'), 'error')
  assert.equal(outcomeOf(null, null), 'ungraded')
})

test('trial names are parsed from Omnara agent names', () => {
  assert.deepEqual(trialFromAgentName('tb4.0 codex run1 gpt-6.1-sol 20261016-111807 · atrx-vep-crispr__uHkTrgv'), {
    trialName: 'atrx-vep-crispr__uHkTrgv',
    task: 'atrx-vep-crispr',
  })
  assert.equal(trialFromAgentName('effort-probe-1'), null)
})

test('the snapshot comparison is stable', () => {
  const a = compare(offline)
  assert.deepEqual(a, compare(structuredClone(offline)))
  assert.equal(a.commonTasks, 65)
  assert.equal(a.omnara.passes, 112)
  assert.equal(a.omnara.graded, 195)
  assert.equal(a.codex.graded, 195)
  assert.equal(a.codexAllTasks.passes, 115)
  assert.equal(a.codexAllTasks.graded, 195)
})

test('API usage replaces trajectory usage for Omnara trials', () => {
  const trial = offline.harbor.trials[0]!
  const summary: SummaryResponse = {
    ...offline,
    agents: [
      {
        agentId: trial.agentId!,
        name: `x · ${trial.trialName}`,
        profileId: null,
        createdAt: '2026-10-16T00:00:00Z',
        modelCalls: 7,
        inputTokens: 100,
        cachedTokens: 40,
        outputTokens: 5,
        reasoningTokens: 1,
        costUsd: 0.5,
        callsWithReportedCost: 7,
      },
    ],
  }
  const run = compare(summary).tasks.flatMap((t) => t.omnara).find((r) => r.agentId === trial.agentId)!
  assert.equal(run.usageSource, 'api')
  assert.equal(run.metrics.modelCalls, 7)
  assert.equal(run.metrics.totalTokens, 105)
  assert.equal(run.metrics.costUsd, 0.5 / 1.05)
})

test('compaction calls are added to trajectory usage', () => {
  const compactions = load<Compaction[]>('omnara-gpt-max-compactions.json')
  const runs = (s: SummaryResponse) => compare(s).tasks.flatMap((t) => t.omnara)
  const before = new Map(runs(offline).map((r) => [r.key, r.metrics]))
  const after = runs({ ...offline, compactions })
  const added = (key: 'costUsd' | 'modelCalls' | 'inputTokens' | 'outputTokens' | 'totalTokens') =>
    after.reduce((sum, r) => sum + r.metrics[key]! - before.get(r.key)![key]!, 0)
  const sum = (f: (c: Compaction) => number) => compactions.reduce((total, c) => total + f(c), 0)
  assert.ok(Math.abs(added('costUsd') - sum((c) => c.costUsd)) < 1e-9)
  assert.equal(added('modelCalls'), compactions.length)
  assert.equal(added('inputTokens'), sum((c) => c.inputTokens))
  assert.equal(added('outputTokens'), sum((c) => c.outputTokens))
  assert.equal(added('totalTokens'), sum((c) => c.inputTokens + c.outputTokens))
  const jax = after.find((r) => r.agentId === 'agt_mzlqduk3vbfn7ed5uxv6a2qr4m')!
  assert.equal(jax.compaction.calls, 4)
  assert.equal(jax.compaction.inputTokens, 223_321)
  assert.ok(Math.abs(jax.compaction.costUsd - 0.9984365) < 1e-9)
})

test('Omnara events become model and tool spans', () => {
  const base = { org_id: 'o', project_id: 'p', agent_id: 'a', turn_id: 't', turn_sequence: 1, is_opening_event: false }
  const events = [
    { ...base, id: 'e1', sequence: 1, event_kind: 'agent_input', agent_input_id: 'i', input_kind: 'content', is_opening_event: true, content_blocks: [{ type: 'text', text: 'do it' }], created_at: '2026-01-01T00:00:00Z' },
    { ...base, id: 'e2', sequence: 2, event_kind: 'model_output', model_call_context_id: 'm', stop_reason: 'tool_use', content_blocks: [{ type: 'tool_call', tool_call_id: 'c1', name: 'run_command', input: '{"command":"ls"}' }], usage: { input_tokens_total: 10, output_tokens_total: 2 }, created_at: '2026-01-01T00:00:02Z' },
    { ...base, id: 'e3', sequence: 3, event_kind: 'tool_result', tool_call_id: 'c1', outcome: 'succeeded', content_blocks: [{ type: 'text', text: 'file' }], created_at: '2026-01-01T00:00:05Z' },
    { ...base, id: 'e4', sequence: 4, event_kind: 'model_output', model_call_context_id: 'm', stop_reason: 'end_turn', content_blocks: [{ type: 'text', text: 'done' }], created_at: '2026-01-01T00:00:06Z' },
  ] as unknown as AgentEvent[]
  const timeline = timelineFromEvents(events)
  const spans = timeline.spans.map((s) => [s.kind, s.name, (s.end - s.start) / 1000])
  assert.deepEqual(spans, [
    ['agent', 'agent', 6],
    ['model', 'model call 1', 2],
    ['tool', 'run_command', 3],
    ['model', 'model call 2', 1],
  ])
  assert.equal(timeline.modelMs, 3000)
  assert.equal(timeline.toolMs, 3000)
  assert.deepEqual(
    timeline.messages.map((m) => m.kind),
    ['user', 'tool_call', 'tool_result', 'assistant'],
  )
})

test('bootstrap intervals are seeded and bracket the estimate', () => {
  const { tasks } = compare(offline)
  const a = pairedBootstrap(tasks, 'passRate')!
  assert.deepEqual(a, pairedBootstrap(tasks, 'passRate'))
  assert.equal(a.omnara.estimate, 112 / 195)
  assert.equal(a.codex.estimate, 115 / 195)
  for (const i of [a.omnara, a.codex, a.diff, a.ratio!]) assert.ok(i.lo <= i.estimate && i.estimate <= i.hi)
  assert.notDeepEqual(a, pairedBootstrap(tasks, 'passRate', { seed: 2 }))
})
