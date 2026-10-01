// Usage: node collect-unlimited-receipt.mjs <isolated NAMZU_HOME> <job-id> <run-id>.
// Records counters and outcome, excluding prompts, credentials, reasoning and search bodies.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [home, jobId, runId] = process.argv.slice(2)
if (!home || !jobId || !runId) throw new Error('Expected isolated home, job ID and run ID')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const schedule = join(home, 'schedule')
const job = json(join(schedule, 'jobs', `${jobId}.json`))
const run = json(join(schedule, 'runs', jobId, `${runId}.json`))
if (run.status === 'running' || run.status === 'queued') throw new Error('Run has not settled')
const projects = join(home, 'projects')
let rows
for (const entry of readdirSync(projects, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const path = join(projects, entry.name, `${run.sessionId}.jsonl`)
  if (existsSync(path)) {
    rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    break
  }
}
if (!rows) throw new Error('Run session not found')
const completed = rows.filter(row => row.type === 'tool_completed')
const calls = {}
for (const row of completed) {
  const count = calls[row.toolName] ?? { completed: 0, errors: 0 }
  count.completed++
  if (row.isError) count.errors++
  calls[row.toolName] = count
}
const usage = rows.filter(row => row.type === 'token_usage_updated')
const turn = rows.findLast(row => row.type === 'turn_completed')
const output = join(job.folder.canonical, 'ai-haberler', 'gunluk.html')
const state = json(join(schedule, 'state', `${jobId}.json`))
process.stdout.write(`${JSON.stringify({
  implementation: 'Locally built worktree CLI after unlimited-token change; not an npm release',
  recordedAt: new Date().toISOString(),
  provider: job.model?.provider,
  model: job.model?.model,
  isolation: 'Private test home/project; public free-provider credential; no scheduler service installed',
  job: { id: jobId, revision: job.revision, budget: job.budget, state: job.state },
  schedule: job.schedule,
  run: { id: runId, sessionId: run.sessionId, status: run.status, reason: run.reason, summary: run.summary, usage: run.usage },
  firstToolRoster: rows.find(row => row.type === 'request_envelope')?.toolNames,
  toolCalls: calls,
  iterations: Math.max(...rows.map(row => row.iteration ?? 0)),
  usageSnapshots: usage.map(row => ({ usage: row.usage, budget: row.budget })),
  terminalStopReason: turn?.stopReason,
  exceededFormerTokenDefault: usage.some(row => row.usage?.totalTokens > 500000),
  allReportedTokenLimitsUnlimited: usage.length > 0 && usage.every(row => row.budget?.limit === 0),
  output: existsSync(output) ? { path: 'ai-haberler/gunluk.html', bytes: statSync(output).size, sha256: createHash('sha256').update(readFileSync(output)).digest('hex') } : null,
  cleanup: { activeRun: state.activeRun ?? null, serviceInstalled: existsSync(join(schedule, 'service.json')), daemonEndpointPresent: existsSync(join(schedule, 'daemon', 'endpoint.json')) },
  caveats: [
    'Output is a local HTML file, not an integrated artifact page.',
    'Iteration and time limits are normal scheduler defaults, not token ceilings.',
    'Completion status and file existence do not establish news accuracy or future unattended execution.',
  ],
}, null, 2)}\n`)
