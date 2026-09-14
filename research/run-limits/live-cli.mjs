// Built CLI and real Muse low. No personal state or credentials are copied.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

if (!process.argv.includes('--live')) throw new Error('Use --live explicitly; this calls Muse low.')
const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = await mkdtemp(join(tmpdir(), 'namzu-unlimited-live-'))
const model = 'muse-spark-1.3-contributor-free'
const report = { root, model, effort: 'low', cases: [], passed: false }
console.log(JSON.stringify({ root }))
try {
  for (const name of ['defaults', 'config', 'flags'].filter(name => !process.argv.includes('--defaults-only') || name === 'defaults')) {
    const home = join(root, name, 'home'), cwd = join(root, name, 'workspace')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await mkdir(cwd)
    await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }))
    await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
    if (name !== 'defaults') await writeFile(join(cwd, 'namzu.config.json'), JSON.stringify({ limits: { tokenBudget: name === 'config' ? 0 : 1, maxIterations: name === 'config' ? 0 : 1, timeoutMs: 0 } }))
    await writeFile(join(cwd, 'receipt.txt'), 'RUN_LIMITS_READY\n')
    const args = [join(repo, 'packages/cli/dist/bin.js'), '--quiet', 'run', 'Read receipt.txt using the read tool, then reply only with its single line. Do not change files or use other tools.', '--trust', '--cwd', cwd, '--provider', 'zen', '--model', model, '--effort', 'low']
    if (name === 'flags') args.push('--token-budget', '0', '--max-iterations', '0')
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2 * 1024 * 1024 })
    const runPaths = (await readdir(home, { recursive: true })).filter(path => path.endsWith('/run.json'))
    const runs = []
    for (const path of runPaths) {
      const run = JSON.parse(await readFile(join(home, path), 'utf8'))
      const events = (await readFile(join(home, path.replace(/run.json$/, 'transcript.jsonl')), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      runs.push({ path, config: { tokenBudget: run.metadata.config.tokenBudget, maxIterations: run.metadata.config.maxIterations, timeoutMs: run.metadata.config.timeoutMs }, status: run.status, iterations: run.currentIteration, usage: run.tokenUsage, budget: run.budget, terminal: events.at(-1) })
    }
    const result = { name, stdout, stderr, runs }
    report.cases.push(result)
    assert.equal(stdout.trim(), 'RUN_LIMITS_READY')
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0].config, { tokenBudget: 0, maxIterations: 0, timeoutMs: 0 })
    assert.ok(runs[0].iterations >= 2, 'A read tool must be followed by the answer request')
    assert.ok(runs[0].usage.totalTokens > 0)
    assert.equal(runs[0].budget.limit, 0)
    assert.equal(runs[0].budget.remainingTokens, null)
    assert.equal(runs[0].budget.ownTokens, runs[0].usage.totalTokens)
    assert.equal(runs[0].budget.unresolvedRequests, 0)
    console.log(JSON.stringify({ case: name, usage: runs[0].usage, passed: true }))
  }
  report.passed = true
} catch (error) {
  report.error = String(error)
  if (error.stdout !== undefined) report.failedProcess = { stdout: error.stdout, stderr: error.stderr, exit: error.code }
  process.exitCode = 1
} finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ report: join(root, 'report.json'), passed: report.passed, error: report.error }))
}
