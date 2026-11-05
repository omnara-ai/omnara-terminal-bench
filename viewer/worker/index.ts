import { type AgentEvent, bearerToken, createOmnaraClient, sdk } from '@omnara/sdk'

import claudeCode from '../data/claude-code-baseline.json'
import codexBaseline from '../data/codex.json'
import gptMaxHarbor from '../data/omnara-gpt-max.json'
import gptMaxCompactions from '../data/omnara-gpt-max-compactions.json'
import opusMaxHarbor from '../data/omnara-opus-max.json'
import type {
  AgentUsage,
  CodexSnapshot,
  Compaction,
  HarborSnapshot,
  OmittedTask,
  SummaryResponse,
  ViewInfo,
} from '../shared/types'

interface Env {
  ASSETS: Fetcher
  OMNARA_API_KEY?: string
  OMNARA_API_URL?: string
  OMNARA_APP_URL?: string
  OMNARA_ORG_ID?: string
  OMNARA_PROJECT_ID?: string
}

interface View {
  info: ViewInfo
  harbor: HarborSnapshot
  baseline: CodexSnapshot
  compactions?: Compaction[]
  static?: boolean
}

const VIEWS: View[] = [
  {
    info: {
      id: 'opus-max',
      label: 'Omnara vs Claude Code',
      baselineName: 'Claude Code',
      model: 'Opus 5.5 · effort max',
    },
    harbor: opusMaxHarbor as HarborSnapshot,
    baseline: claudeCode as CodexSnapshot,
    static: true,
  },
  {
    info: {
      id: 'gpt-max-v4',
      label: 'Omnara v4 vs Codex',
      baselineName: 'Codex',
      model: 'GPT-6.1 Sol · effort max · v4 prompt · Codex 0.166.0 on Modal',
      modelOnly: true,
    },
    harbor: gptMaxHarbor as HarborSnapshot,
    baseline: codexBaseline as CodexSnapshot,
    compactions: gptMaxCompactions,
    static: true,
  },
]
const DEFAULT_VIEW = 'opus-max'
const viewOf = (id: string | null) => VIEWS.find((v) => v.info.id === id) ?? VIEWS.find((v) => v.info.id === DEFAULT_VIEW)!
const SUMMARY_SHAPE = 2
const DATA_VERSION = (() => {
  let hash = 2166136261
  for (const char of JSON.stringify([SUMMARY_SHAPE, VIEWS])) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return (hash >>> 0).toString(36)
})()
const HUB = 'https://hub.harborframework.com'
const CACHE_SECONDS = 600

function omnara(env: Env, harborSnapshot: HarborSnapshot = opusMaxHarbor as HarborSnapshot) {
  if (!env.OMNARA_API_KEY) throw new Error('OMNARA_API_KEY is not set (see .dev.vars.example)')
  const client = createOmnaraClient({
    baseUrl: env.OMNARA_API_URL || 'https://api.omnara.com/v1',
    auth: bearerToken(env.OMNARA_API_KEY),
  })
  const path = {
    orgID: env.OMNARA_ORG_ID || harborSnapshot.orgId,
    projectID: env.OMNARA_PROJECT_ID || harborSnapshot.projectId,
  }
  return { client, path }
}

async function listRunAgents(env: Env, harborSnapshot: HarborSnapshot): Promise<AgentUsage[]> {
  const { client, path } = omnara(env, harborSnapshot)
  const agents: AgentUsage[] = []
  for (const run of harborSnapshot.runs) {
    let cursor: string | undefined
    do {
      const { data } = await sdk.listAgents({
        client,
        path,
        query: { agent_profile_id: run.profileId, include_usage: true, include_archived: true, limit: 100, cursor },
      })
      for (const agent of data.data) {
        const usage = agent.usage
        const reported = usage?.cost.model_calls_with_reported_cost ?? 0
        agents.push({
          agentId: agent.id,
          name: agent.name,
          profileId: agent.agent_profile_id ?? null,
          createdAt: agent.created_at,
          modelCalls: usage?.model_calls ?? 0,
          inputTokens: usage?.tokens.input_tokens_total ?? 0,
          cachedTokens: usage?.tokens.cache_read_input_tokens ?? 0,
          outputTokens: usage?.tokens.output_tokens_total ?? 0,
          reasoningTokens: usage?.tokens.reasoning_output_tokens ?? 0,
          costUsd: reported > 0 ? Number(usage?.cost.provider_reported_usd) : null,
          callsWithReportedCost: reported,
        })
      }
      cursor = data.next_cursor ?? undefined
    } while (cursor)
  }
  return agents
}

const RUN_EXCLUSIONS: OmittedTask[] = [
  { task: 'cad-model', reason: 'Reference solution fails' },
  ...['formal-crypto', 'html-js-filter', 'interleaved-vigenere', 'shadow-relay', 'uefi-bootkit'].map((task) => ({
    task,
    reason: 'Security task',
  })),
]

function omittedTasks(view: View): OmittedTask[] {
  const ran = new Set(view.harbor.trials.map((t) => t.task))
  const refused = (view.harbor.excludedTasks ?? [])
    .filter((task) => !RUN_EXCLUSIONS.some((e) => e.task === task))
    .map((task) => ({ task, reason: 'Model refusals' }))
  return [...RUN_EXCLUSIONS.filter((e) => !ran.has(e.task)), ...refused]
}

async function summary(env: Env, view: View): Promise<SummaryResponse> {
  const appUrl = (env.OMNARA_APP_URL || 'https://app.omnara.com').replace(/\/$/, '')
  const base = {
    view: view.info,
    views: VIEWS.map((v) => v.info),
    harbor: view.harbor,
    codex: view.baseline,
    compactions: view.compactions,
    appUrl,
    omitted: omittedTasks(view),
  }
  if (view.static) return { ...base, agents: [] }
  try {
    return { ...base, agents: await listRunAgents(env, view.harbor) }
  } catch (error) {
    return { ...base, agents: [], apiError: String(error) }
  }
}

async function agentEvents(env: Env, agentID: string): Promise<AgentEvent[]> {
  const { client, path } = omnara(env)
  const events: AgentEvent[] = []
  let after: number | undefined
  for (;;) {
    const { data } = await sdk.listEvents({
      client,
      path: { ...path, agentID },
      query: { after_sequence: after, limit: 500 },
    })
    events.push(...data.data)
    if (!data.has_more || data.data.length === 0) return events
    after = data.next_after_sequence
  }
}

async function baselineTrajectory(id: string, jobId: string): Promise<Response> {
  const trajectoryPath = encodeURIComponent(`trials/${id}/trajectory.json`)
  const upstream = await fetch(`${HUB}/api/trials/${id}/trajectory?jobId=${jobId}&trajectory_path=${trajectoryPath}`)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': 'application/json' },
  })
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

async function route(request: Request, env: Env): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url)
  if (pathname === '/api/summary') {
    const body = await summary(env, viewOf(searchParams.get('view')))
    const response = json(body)
    if (body.apiError) response.headers.set('x-api-error', '1')
    return response
  }
  const agent = pathname.match(/^\/api\/agents\/(agt_[a-z0-9]+)\/events$/)
  if (agent) {
    const exported = await env.ASSETS.fetch(new Request(new URL(`/events/${agent[1]}.json`, request.url)))
    if (exported.ok && exported.headers.get('content-type')?.includes('json')) {
      return new Response(exported.body, { headers: { 'content-type': 'application/json' } })
    }
    return json(await agentEvents(env, agent[1]!))
  }
  const trial = pathname.match(/^\/api\/codex\/trials\/([0-9a-f-]{36})\/trajectory$/)
  if (trial) {
    const exported = await env.ASSETS.fetch(new Request(new URL(`/trajectories/${trial[1]}.json`, request.url)))
    if (exported.ok && exported.headers.get('content-type')?.includes('json')) {
      return new Response(exported.body, { headers: { 'content-type': 'application/json' } })
    }
  }
  const owner = trial && VIEWS.find((v) => v.baseline.trials.some((t) => t.id === trial[1]))
  if (trial && owner) return baselineTrajectory(trial[1]!, owner.baseline.jobId)
  return null
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)

    const cache = (caches as unknown as { default: Cache }).default
    const key = new URL(request.url)
    key.searchParams.set('data', DATA_VERSION)
    const cacheKey = new Request(key, request)
    const hit = await cache.match(cacheKey)
    if (hit) return hit
    let response: Response | null
    try {
      response = await route(request, env)
    } catch (error) {
      return json({ error: String(error) }, 502)
    }
    if (!response) return json({ error: 'not found' }, 404)
    if (response.ok && !response.headers.has('x-api-error')) {
      const cacheable = new Response(response.body, response)
      cacheable.headers.set('cache-control', `public, max-age=0, s-maxage=${CACHE_SECONDS}`)
      ctx.waitUntil(cache.put(cacheKey, cacheable.clone()))
      return cacheable
    }
    return response
  },
} satisfies ExportedHandler<Env>
