import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { type AtifTrajectory, trajectoryMetrics } from '../shared/atif'
import type { CodexSnapshot, CodexTrial } from '../shared/types'

const jobsDir = join(import.meta.dirname, '..', '..', 'jobs')
const trajectoriesDir = join(import.meta.dirname, '..', 'public', 'trajectories')
const { values, positionals: prefixes } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: join(import.meta.dirname, '..', 'data', 'codex.json') },
  },
})
if (prefixes.length === 0) throw new Error('pass one job-directory prefix per run')
const GRADED_EXCEPTIONS = new Set(['AgentTimeoutError', 'VerifierTimeoutError', 'NonZeroAgentExitCodeError'])

interface TrialResult {
  id: string
  task_name: string
  trial_name: string
  finished_at?: string | null
  agent_result?: { cost_usd?: number | null } | null
  verifier_result?: { rewards?: { reward?: number } } | null
  exception_info?: { exception_type?: string } | null
}

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function main() {
  await mkdir(trajectoriesDir, { recursive: true })
  const jobNames = (await readdir(jobsDir)).sort()
  const trials: CodexTrial[] = []
  for (const prefix of prefixes) {
    // A comma-separated list of prefixes makes one run of several jobs, e.g. tasks served by different providers.
    const parts = prefix.split(',')
    const jobs = jobNames.filter((name) => parts.some((part) => name.startsWith(part)))
    if (jobs.length === 0) throw new Error(`no job directories start with ${prefix}`)
    const byTask = new Map<string, { result: TrialResult; dir: string }>()
    for (const job of jobs) {
      for (const entry of (await readdir(join(jobsDir, job))).sort()) {
        if (!entry.includes('__')) continue
        const dir = join(jobsDir, job, entry)
        const result = await readJson<TrialResult>(join(dir, 'result.json'))
        if (!result?.finished_at) continue
        const infraError =
          result.verifier_result?.rewards?.reward == null &&
          !GRADED_EXCEPTIONS.has(result.exception_info?.exception_type ?? '')
        if (infraError) continue
        const task = result.task_name.replace(/^terminal-bench\//, '')
        const prior = byTask.get(task)
        if (!prior || (prior.result.finished_at ?? '') < result.finished_at) byTask.set(task, { result, dir })
      }
    }
    for (const [task, { result, dir }] of byTask) {
      const trajectoryPath = join(dir, 'agent', 'trajectory.json')
      const traj = await readJson<AtifTrajectory>(trajectoryPath)
      if (traj?.steps) await copyFile(trajectoryPath, join(trajectoriesDir, `${result.id}.json`))
      trials.push({
        id: result.id,
        task,
        trialName: result.trial_name,
        reward: result.verifier_result?.rewards?.reward ?? null,
        exception: result.exception_info?.exception_type ?? null,
        hubCostUsd: result.agent_result?.cost_usd ?? null,
        trajectory: traj?.steps ? trajectoryMetrics(traj) : null,
      })
    }
  }
  trials.sort((a, b) => a.task.localeCompare(b.task) || a.trialName.localeCompare(b.trialName))
  const snapshot: CodexSnapshot = { jobId: '', trials }
  const out = resolve(values.out)
  await writeFile(out, `${JSON.stringify(snapshot, null, 1)}\n`)
  const passed = trials.filter((t) => t.reward === 1).length
  console.log(`wrote ${out}: ${prefixes.length} runs, ${trials.length} trials, ${passed} passed`)
}

await main()
