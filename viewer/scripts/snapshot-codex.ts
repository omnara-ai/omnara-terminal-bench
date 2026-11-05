import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { type AtifTrajectory, trajectoryMetrics } from '../shared/atif'
import type { CodexSnapshot, CodexTrial } from '../shared/types'

const HUB = 'https://hub.harborframework.com'
const { values } = parseArgs({
  options: {
    job: { type: 'string', default: '96ad98a5-70e6-5e7b-bd1e-67eecfbc644c' },
    out: { type: 'string', default: join(import.meta.dirname, '..', 'data', 'claude-code-baseline.json') },
  },
})
const jobId = values.job
const cacheDir = join(import.meta.dirname, '..', '.cache', 'hub', jobId)

async function cached(name: string, url: string): Promise<string> {
  const path = join(cacheDir, name)
  try {
    return await readFile(path, 'utf8')
  } catch {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url)
      if (response.ok) {
        const body = await response.text()
        await writeFile(path, body)
        return body
      }
      if (response.status === 404 || attempt === 4) throw new Error(`${url}: HTTP ${response.status}`)
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
    }
  }
}

const decode = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

const number = (text: string) => {
  const n = Number(text.replace(/[$,]/g, ''))
  return text === '-' || text === '' || !Number.isFinite(n) ? null : n
}

interface HubRow {
  id: string
  cells: Record<string, string>
}

async function jobRows(): Promise<{ label: string; rows: HubRow[] }> {
  const rows: HubRow[] = []
  let label = ''
  for (let page = 1; ; page++) {
    const html = await cached(`results-${page}.html`, `${HUB}/jobs/${jobId}?tab=results&page=${page}`)
    label ||= html.match(/Terminal-Bench [\d.]+ · ([^<"|]+?)(?: \||">|<)/)?.[1]?.trim() ?? ''
    const head = html.match(/<thead.*?<\/thead>/s)?.[0] ?? ''
    const columns = [...head.matchAll(/<th[^>]*>(.*?)<\/th>/gs)].map((m) => decode(m[1] ?? ''))
    const pageRows = [...html.matchAll(/data-row-id="([0-9a-f-]{36})"(.*?)<\/tr>/gs)]
    if (pageRows.length === 0) break
    for (const [, id, body] of pageRows) {
      const tds = [...(body ?? '').matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => decode(m[1] ?? ''))
      rows.push({ id: id!, cells: Object.fromEntries(columns.map((c, i) => [c, tds[i] ?? ''])) })
    }
  }
  return { label, rows }
}

async function trajectory(id: string): Promise<AtifTrajectory | null> {
  const path = encodeURIComponent(`trials/${id}/trajectory.json`)
  try {
    const body = await cached(
      `traj-${id}.json`,
      `${HUB}/api/trials/${id}/trajectory?jobId=${jobId}&trajectory_path=${path}`,
    )
    const parsed = JSON.parse(body) as AtifTrajectory
    return Array.isArray(parsed.steps) ? parsed : null
  } catch (error) {
    console.warn(`no trajectory for ${id}: ${(error as Error).message}`)
    return null
  }
}

async function main() {
  await mkdir(cacheDir, { recursive: true })
  const { label, rows } = await jobRows()
  console.log(`${rows.length} trials in job ${jobId} (${label})`)

  const trials: CodexTrial[] = []
  const queue = [...rows]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        const traj = await trajectory(row.id)
        const c = row.cells
        trials.push({
          id: row.id,
          task: (c.Task ?? '').replace(/^terminal-bench\//, ''),
          trialName: (c.Trial ?? '').split(' ')[0] ?? '',
          reward: number(c.Reward ?? ''),
          exception: c.Exception && c.Exception !== '-' ? c.Exception : null,
          hubCostUsd: number(c.Cost ?? ''),
          trajectory: traj ? trajectoryMetrics(traj) : null,
        })
      }
    }),
  )
  trials.sort((a, b) => a.task.localeCompare(b.task) || a.trialName.localeCompare(b.trialName))

  const snapshot: CodexSnapshot = { jobId, trials }
  const out = resolve(values.out)
  await mkdir(join(out, '..'), { recursive: true })
  await writeFile(out, `${JSON.stringify(snapshot, null, 1)}\n`)
  const missing = trials.filter((t) => !t.trajectory).length
  console.log(`wrote ${out}: ${trials.length} trials, ${missing} without a trajectory`)
}

await main()
