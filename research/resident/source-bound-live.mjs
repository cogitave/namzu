// Targeted integration: scripted promotion evidence, real built CLI / Muse-low admissions.
// This validates source invalidation, not the quality of the scripted learning experiment.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DiskResidentAgenda, hashResidentSkill, projectResidentLearning } from '../../packages/sdk/dist/index.js'
import { residentLearningSources } from '../../packages/cli/dist/integrations/resident/learning-sources.js'
if (!process.argv.includes('--live')) throw new Error('Explicit --live required; uses Muse low.')
const root = await mkdtemp(join(tmpdir(), 'namzu-bound-learning-'))
const home = join(root, 'home'), cwd = join(root, 'workspace')
const cli = fileURLToPath(new URL('../../packages/cli/dist/bin.js', import.meta.url))
const model = 'muse-spark-1.3-contributor-free'
const report = { root, model, effort: 'low', promotionEvidence: 'scripted control, not empirical improvement', cases: [], passed: false }
console.log(JSON.stringify({ root }))
await mkdir(home, { mode: 0o700 }); await mkdir(cwd)
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }))
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
const map = JSON.stringify({ current: 'old.txt' })
await writeFile(join(cwd, 'routing.json'), map)
await writeFile(join(cwd, 'old.txt'), 'SOURCE_A_READY\n')
await writeFile(join(cwd, 'new.txt'), 'SOURCE_B_READY\n')
const command = async (...args) => {
 const { stdout } = await promisify(execFile)(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd], { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 90000, maxBuffer: 2000000 })
 return JSON.parse(stdout)
}
const objective = 'Read routing.json and the file it currently selects. Return complete with only that file’s single line as summary. Do not modify files or run commands. If routing.json is unavailable, return blocked with summary SOURCE_UNAVAILABLE; never infer its current selection from history.'
const add = () => command('add', '--trust', objective)
try {
 await add()
 const [project] = await readdir(join(home, 'residents'))
 const binding = JSON.parse(await readFile(join(home, 'residents', project, 'default/binding.json')))
 const agenda = new DiskResidentAgenda(join(home, 'residents', project), binding)
 const before = await agenda.read()
 const candidate = { name: 'old-routing', description: 'Workspace routing under the observed map.', body: 'The selected source is old.txt; read its exact value. This instruction depends on the recorded routing map.', sources: [{ key: 'workspace-file:routing.json', revision: createHash('sha256').update(map).digest('hex') }] }
 const hash = hashResidentSkill(candidate)
 const round = (prefix) => {
  const baseline = [], updated = [], attributions = []
  for (let i = 0; i < 5; i++) {
   const taskId = `${prefix}-${i}`
   for (let trial = 0; trial < 2; trial++) for (const [arm, passed, target] of [['baseline', false, baseline], ['candidate', true, updated]]) {
    const result = { case: taskId, status: passed ? 'passed' : 'failed', passed, mean: Number(passed), scores: { control: { score: Number(passed), reason: 'Scripted state-machine control' } }, run: { output: String(passed), steps: [], toolCalls: [], stopReason: 'end_turn', totalTokens: 0, totalCostUsd: 0, durationMs: 0 } }
    target.push({ taskId, trial, conditions: `${taskId}-${trial}`, trajectoryId: `${arm}-${taskId}-${trial}`, result })
   }
   attributions.push({ taskId, effect: 'improvement', reason: 'Scripted control only', baselineTrajectories: baseline.filter(t => t.taskId === taskId).map(t => t.trajectoryId), candidateTrajectories: updated.filter(t => t.taskId === taskId).map(t => t.trajectoryId) })
  }
  return { baselineRevision: 'none', candidateRevision: hash, baseline, candidate: updated, attributions }
 }
 await agenda.promoteSkill(before, candidate, { verification: round('v'), confirmation: round('c') }, { key: randomUUID(), source: 'scripted-integration-control', reason: 'Test transport of approved content; not evidence of learned improvement.' })
 for (const [name, expected] of [['matching', 'SOURCE_A_READY'], ['changed', 'SOURCE_B_READY'], ['missing', 'SOURCE_UNAVAILABLE']]) {
  if (name === 'changed') await writeFile(join(cwd, 'routing.json'), JSON.stringify({ current: 'new.txt' }))
  if (name === 'missing') await unlink(join(cwd, 'routing.json'))
  if (name !== 'matching') await add()
  // Reopen from disk for every admission; no shared in-memory source revision.
  const reopened = new DiskResidentAgenda(join(home, 'residents', project), binding)
  const snapshot = await reopened.read()
  const projection = projectResidentLearning(snapshot.learning, { maxChars: 12000, skillNames: [candidate.name], sources: residentLearningSources(cwd, snapshot.learning)() })
  assert.equal(projection.includedSkills.length, name === 'matching' ? 1 : 0)
  await command('run', '--trust', '--max-steps', '1', '--max-iterations', '8', '--token-budget', '0', '--provider', 'zen', '--model', model, '--effort', 'low')
  const settled = (await reopened.read()).pursuits.at(-1).state
  report.cases.push({ name, expected, phase: settled.phase, summary: settled.summary, includedSkills: projection.includedSkills, withheldSkills: projection.withheldSkills })
  assert.equal(settled.summary.trim(), expected)
  assert.equal(settled.phase, name === 'missing' ? 'blocked' : 'complete')
 }
 await agenda.rollbackSkill(await agenda.read(), candidate.name, before.revision, { key: randomUUID(), source: 'integration-control', reason: 'Remove the scripted test skill.' })
 assert.equal((await new DiskResidentAgenda(join(home, 'residents', project), binding).read()).learning.skills.length, 0)
 report.rollback = true
 report.inspection = await command('inspect')
 report.passed = true
} catch (error) { report.error = String(error); process.exitCode = 1 }
finally { await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ root, passed: report.passed, error: report.error })) }
