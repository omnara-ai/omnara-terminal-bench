import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { type AtifTrajectory, trajectoryMetrics } from '../shared/atif'
import type { HarborRun, HarborSnapshot, HarborTrial } from '../shared/types'

const jobsDir = join(import.meta.dirname, '..', '..', 'jobs')
const { values, positionals: prefixes } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: join(import.meta.dirname, '..', 'data', 'harbor-results.json') },
    exclude: { type: 'string', default: '' },
    'valid-only': { type: 'boolean', default: false },
    skip: { type: 'string', default: '' },
    'attempts-as-runs': { type: 'boolean', default: false },
    'price-as': { type: 'string' },
  },
})
if (values['attempts-as-runs'] && prefixes.length !== 1) throw new Error('--attempts-as-runs takes exactly one prefix')
const excluded = new Set(values.exclude.split(',').filter(Boolean))
const GRADED_EXCEPTIONS = new Set(['AgentTimeoutError', 'VerifierTimeoutError'])
const skipped = new Set(values.skip.split(',').filter(Boolean))
if (prefixes.length === 0) throw new Error('pass one job-directory prefix per run')

interface TrialResult {
  task_name: string
  trial_name: string
  started_at?: string | null
  finished_at?: string | null
  config: { agent: { kwargs: Record<string, string> }; job_id: string }
  agent_result?: { metadata?: { omnara_agent_id?: string; stop_reason?: string } } | null
  verifier_result?: { rewards?: { reward?: number } } | null
  exception_info?: { exception_type?: string } | null
  agent_execution?: { started_at?: string; finished_at?: string } | null
}

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

const seconds = (span?: { started_at?: string; finished_at?: string } | null) =>
  span?.started_at && span.finished_at
    ? (Date.parse(span.finished_at) - Date.parse(span.started_at)) / 1000
    : null

// OpenRouter's list prices, priced per model call like omnara_harbor/atif.py does. The harness only
// prices models whose name is an OpenRouter id, so runs on other providers record no cost.
interface Tier {
  prompt: number
  completion: number
  cacheRead: number
  cacheWrite: number
}
interface Usage {
  input_tokens_total?: number
  cache_read_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens_total?: number
}

async function openrouterPricing(model: string) {
  const { data } = (await (await fetch('https://openrouter.ai/api/v1/models')).json()) as {
    data: { id: string; pricing?: Record<string, unknown> }[]
  }
  const p = data.find((m) => m.id === model)?.pricing
  if (!p) throw new Error(`OpenRouter has no prices for ${model}`)
  const tier = (src: Record<string, unknown>): Tier => {
    const prompt = Number(src.prompt ?? 0)
    return {
      prompt,
      completion: Number(src.completion ?? 0),
      cacheRead: Number(src.input_cache_read ?? prompt),
      cacheWrite: Number(src.input_cache_write ?? prompt),
    }
  }
  const long = (p.overrides as Record<string, unknown>[] | undefined)?.find((o) => 'min_prompt_tokens' in o)
  return (usage: Usage) => {
    const input = usage.input_tokens_total ?? 0
    const t = long && input >= Number(long.min_prompt_tokens) ? tier({ ...p, ...long }) : tier(p)
    const read = usage.cache_read_input_tokens ?? 0
    const write = usage.cache_write_input_tokens ?? 0
    return (
      Math.max(input - read - write, 0) * t.prompt +
      read * t.cacheRead +
      write * t.cacheWrite +
      (usage.output_tokens_total ?? 0) * t.completion
    )
  }
}
const priceCall = values['price-as'] ? await openrouterPricing(values['price-as']) : null

async function eventsCost(dir: string): Promise<number | null> {
  if (!priceCall) return null
  const raw = await readJson<{ data?: unknown[] } | unknown[]>(join(dir, 'agent', 'omnara-events.json'))
  const events = (Array.isArray(raw) ? raw : raw?.data) as { event_kind?: string; usage?: Usage }[] | undefined
  if (!events) return null
  return events.reduce((sum, e) => sum + (e.event_kind === 'model_output' && e.usage ? priceCall(e.usage) : 0), 0)
}

async function main() {
  const jobNames = (await readdir(jobsDir)).sort()
  const runs: HarborRun[] = []
  const trials: HarborTrial[] = []
  let orgId = ''
  let projectId = ''

  for (const [index, prefix] of prefixes.entries()) {
    const run = prefix.match(/run\d+/)?.[0] ?? `run${index + 1}`
    // A comma-separated list of prefixes makes one run of several jobs, e.g. tasks served by different providers.
    const parts = prefix.split(',')
    const jobs = jobNames.filter((name) => parts.some((part) => name.startsWith(part)))
    if (jobs.length === 0) throw new Error(`no job directories start with ${prefix}`)
    const byTask = new Map<string, { result: TrialResult; job: string; dir: string }>()
    const attempts = new Map<string, { result: TrialResult; job: string; dir: string }[]>()
    let profile: Record<string, string> | undefined

    for (const job of jobs) {
      const config = await readJson<{ agents?: { kwargs?: Record<string, string> }[] }>(join(jobsDir, job, 'config.json'))
      if (config?.agents?.[0]?.kwargs?.profile_id) profile ??= config.agents[0].kwargs
      for (const entry of (await readdir(join(jobsDir, job))).sort()) {
        if (!entry.includes('__')) continue
        const dir = join(jobsDir, job, entry)
        const result = await readJson<TrialResult>(join(dir, 'result.json'))
        if (!result?.finished_at) continue
        profile ??= result.config.agent.kwargs
        if (skipped.has(`${job}/${entry}`)) continue
        const infraError =
          result.verifier_result?.rewards?.reward == null &&
          !GRADED_EXCEPTIONS.has(result.exception_info?.exception_type ?? '')
        if (values['valid-only'] && infraError) continue
        const task = result.task_name.replace(/^terminal-bench\//, '')
        if (excluded.has(task)) continue
        if (values['attempts-as-runs']) {
          attempts.set(task, [...(attempts.get(task) ?? []), { result, job, dir }])
          continue
        }
        const prior = byTask.get(task)
        if (!prior || (prior.result.finished_at ?? '') < result.finished_at) {
          byTask.set(task, { result, job, dir })
        }
      }
    }
    if (!profile?.profile_id) throw new Error(`no finished trials with an agent profile under ${prefix}`)
    orgId ||= profile.org_id ?? ''
    projectId ||= profile.project_id ?? ''

    const picked: { run: string; task: string; result: TrialResult; job: string; dir: string }[] = []
    if (values['attempts-as-runs']) {
      for (const [task, list] of attempts) {
        list.sort((a, b) => (a.result.started_at ?? '').localeCompare(b.result.started_at ?? ''))
        list.forEach((entry, i) => picked.push({ run: `run${i + 1}`, task, ...entry }))
      }
      const attemptRuns = [...new Set(picked.map((p) => p.run))].sort()
      for (const name of attemptRuns.length ? attemptRuns : ['run1']) {
        runs.push({ run: name, profileId: profile.profile_id })
      }
    } else {
      for (const [task, entry] of byTask) picked.push({ run, task, ...entry })
      runs.push({ run, profileId: profile.profile_id })
    }

    picked.sort((a, b) => a.task.localeCompare(b.task) || a.run.localeCompare(b.run))
    for (const { run, task, result, job, dir } of picked) {
      const traj = await readJson<AtifTrajectory>(join(dir, 'agent', 'trajectory.json'))
      const trajectory = traj?.steps ? trajectoryMetrics(traj) : null
      if (trajectory && trajectory.costUsd === null) trajectory.costUsd = await eventsCost(dir)
      const metadata = result.agent_result?.metadata
      trials.push({
        run,
        task,
        trialName: result.trial_name,
        agentId: metadata?.omnara_agent_id ?? null,
        reward: result.verifier_result?.rewards?.reward ?? null,
        exception: result.exception_info?.exception_type ?? null,
        stoppedMidTurn: metadata?.stop_reason !== undefined && metadata.stop_reason !== 'end_turn',
        harborAgentSeconds: seconds(result.agent_execution),
        trajectory,
      })
    }
  }

  const snapshot: HarborSnapshot = { orgId, projectId, runs, trials, excludedTasks: [...excluded].sort() }
  const out = resolve(values.out)
  await writeFile(out, `${JSON.stringify(snapshot, null, 1)}\n`)
  const passed = trials.filter((t) => t.reward === 1).length
  console.log(`wrote ${out}: ${runs.length} runs, ${trials.length} trials, ${passed} passed`)
}

await main()
