import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sdk from '../../packages/sdk/dist/index.js'

const root = process.argv[2]
if (!root) throw new Error('Usage: node autonomous-learning-audit.mjs <study-root> [output.json]')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const lines = async path => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
const report = await json(join(root, 'report.json')), spec = await json(join(root, 'spec.json'))
assert.equal(report.live, spec.live)
assert.deepEqual(report.spec, spec)
const sourceChecks = []
for (const [path, preparedDigest] of Object.entries(spec.sourceHashes)) {
  const bytes = await readFile(join(fileURLToPath(new URL('../../', import.meta.url)), path))
  // The study's shared sha helper hashes the JSON representation of its input.
  assert.equal(digest(JSON.stringify(bytes.toString('utf8'))), preparedDigest, `Prepared source changed: ${path}`)
  sourceChecks.push({ path, preparedDigest, fileSha256: digest(bytes) })
}
const attempts = await lines(join(root, 'attempts.jsonl')), runs = await lines(join(root, 'runs.jsonl'))
assert.equal(attempts.length, runs.length, 'An attempted run has no settled retained result.')
assert.equal(new Set(runs.map(r => r.runId)).size, runs.length)
assert.deepEqual(attempts.map(r => r.label), runs.map(r => r.label))
assert.deepEqual(report.runs, runs)
assert.equal(report.recordedTokens, runs.reduce((n, r) => n + r.tokens, 0))
const paths = await readdir(join(root, 'runs'), { recursive: true })
const evidence = []
for (const run of runs) {
  const found = paths.filter(p => p.endsWith(`/runs/${run.runId}/run.json`))
  assert.equal(found.length, 1)
  const dir = join(root, 'runs', found[0].slice(0, -'run.json'.length))
  const record = await json(join(dir, 'run.json')), events = await lines(join(dir, 'transcript.jsonl'))
  const final = events.findLast(e => e.type === 'run_completed')
  assert.ok(final, `No terminal event for ${run.runId}`)
  assert.equal(final.result ?? '', run.output)
  assert.equal(final.stopReason, run.stopReason)
  assert.equal(record.tokenUsage.totalTokens, run.tokens)
  if (spec.live) {
    assert.equal(record.metadata.config.model, 'muse-spark-1.3-contributor-free')
    assert.equal(record.metadata.config.effort, 'low')
  }
  const tools = events.filter(e => ['tool_executing', 'tool_completed'].includes(e.type))
    .map(({ type, toolUseId, toolName, input, result, isError }) => ({ type, toolUseId, toolName, input, result, isError }))
  if (['explore', 'generate'].includes(run.label)) {
    const stored = await json(join(dir, 'messages.json'))
    const visible = JSON.stringify(stored.messages)
    for (const fixture of [...spec.verification, ...spec.confirmation, ...spec.holdout].filter(f => ['invoice', 'memo', 'notice'].includes(f.family))) {
      assert.ok(!visible.includes(fixture.expected), 'Withheld answer leaked into learner input.')
      assert.ok(!visible.includes(JSON.parse(fixture.files['input.txt']).id), 'Withheld input leaked into learner input.')
    }
  }
  evidence.push({ runId: run.runId, label: run.label, stopReason: run.stopReason, tools,
    transcriptSha256: digest(await readFile(join(dir, 'transcript.jsonl'))) })
}
for (const row of report.scored) {
  const fixture = [spec.seed, ...spec.verification, ...spec.confirmation, ...spec.holdout].find(f => f.id === row.case)
  assert.ok(fixture)
  const original = runs.find(r => r.runId === row.runId)
  assert.equal(original.output, row.output)
  const inputUnchanged = await readFile(join(root, 'cases', digest(JSON.stringify(row.label)), 'input.txt'), 'utf8') === fixture.files['input.txt']
  assert.equal(row.expected, fixture.expected)
  assert.equal(row.passed, original.usageComplete && original.stopReason === 'end_turn' && original.output.trim() === fixture.expected && original.tools.some(t => t.name === 'read' && t.success) && inputUnchanged)
}
const generated = runs.find(r => r.label === 'generate')
if (generated) assert.deepEqual(JSON.parse(generated.output.replace(/^```(?:json)?\s*|\s*```$/g, '')), report.candidate)
const probeCalls = await lines(join(root, 'probes.jsonl'))
assert.deepEqual(JSON.parse(report.observations.trace), probeCalls)
const explorationTools = evidence.find(e => e.label === 'explore').tools
assert.deepEqual(explorationTools.filter(t => t.type === 'tool_executing' && t.toolName === 'preview_route').map(t => t.input), probeCalls.map(t => t.input))
assert.deepEqual(explorationTools.filter(t => t.type === 'tool_completed' && t.toolName === 'preview_route').map(t => ({ success: !t.isError, output: t.result })), probeCalls.map(t => ({ success: t.success, output: t.output })))
const explored = report.events.find(event => event.kind === 'exploration')
assert.deepEqual(explored.data.observations, report.observations)
assert.equal(explored.data.digest, digest(JSON.stringify(report.observations)))
assert.ok(report.events.findIndex(e => e.kind === 'exploration') < report.events.findIndex(e => e.kind === 'candidate'))
assert.deepEqual(report.events[0].data.protection, spec.protection)
const receipts = report.events.filter(e => e.kind === 'usage').map(e => e.data.receipt)
assert.equal(new Set(receipts.map(r => r.runId)).size, receipts.length)
assert.equal(receipts.reduce((n, r) => n + (r.tokens ?? 0), 0), report.cycle.result.consumption.tokens)
for (const receipt of receipts) {
  const run = runs.find(r => r.runId === receipt.runId)
  assert.ok(run)
  assert.equal(receipt.tokens, run.usageComplete ? run.tokens : null)
  assert.equal(receipt.costUsd, run.usageComplete && run.cost?.unpricedTokens === 0 ? run.cost.totalCost : null)
}
const expectedLabels = ['seed-invoice-0/baseline', 'explore', 'generate',
  ...[...spec.verification, ...spec.confirmation].flatMap(f => ['baseline', 'memory', 'candidate'].map(arm => `${f.id}/${arm}`)),
  ...(report.cycle.status === 'activated' ? spec.holdout.flatMap(f => ['reopened', 'rollback'].map(arm => `${f.id}/${arm}`)) : [])]
assert.deepEqual(runs.map(r => r.label).sort(), expectedLabels.sort(), 'Study protocol has missing or extra runs.')

const [projectId] = await readdir(join(root, 'home/residents'))
const binding = await json(join(root, 'home/residents', projectId, 'default/binding.json'))
const store = new sdk.SqliteResidentLearningStore({ databasePath: join(root, 'home/state/learning.sqlite'), artifactsPath: join(root, 'home/learning/artifacts'), scope: { ...binding, projectId }, readOnly: true })
const cycle = await store.get(report.cycle.cycleId)
const verification = await store.readArtifact(cycle.cycleId, 'verification')
const confirmation = await store.readArtifact(cycle.cycleId, 'confirmation').catch(() => undefined)
const review = sdk.reviewHarnessCandidate(verification, confirmation, spec.protection)
if (cycle.status === 'activated') {
  assert.equal(review.decision, 'accept')
  const agenda = new sdk.DiskResidentAgenda(join(root, 'home/residents', projectId), binding)
  const activated = await agenda.readRevision(cycle.result.agendaRevision)
  assert.equal(activated.learning.skills[0].hash, sdk.hashResidentSkill(report.candidate))
  assert.equal((await agenda.read()).learning.skills.length, 0, 'Rollback did not remove the skill.')
}
const audit = { ...report, root: undefined, audit: { verified: true, sourceReportSha256: digest(await readFile(join(root, 'report.json'))),
  sourceChecks, preparedSourceDigestEncoding: 'sha256(JSON.stringify(UTF-8 file text))',
  originalTranscriptChecks: evidence, probeCalls: probeCalls.length, probeRecords: probeCalls.reduce((n, p) => n + p.input.records.length, 0),
  totalToolErrors: evidence.flatMap(e => e.tools).filter(t => t.type === 'tool_completed' && t.isError).length,
  review: review.decision, receiptCount: receipts.length } }
const out = process.argv[3] ?? join(root, 'audited.json')
await writeFile(out, `${JSON.stringify(audit, null, 2)}\n`)
console.log(JSON.stringify({ out, outcome: cycle.status, rounds: audit.rounds, tokens: audit.recordedTokens, probes: audit.audit.probeRecords, toolErrors: audit.audit.totalToolErrors }))
