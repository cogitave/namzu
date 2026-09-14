import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sdk from '../../packages/sdk/dist/index.js'
import { sha, predictionInstructions, skillName } from './exploration-policy-host.mjs'
import { baselinePolicy, preview } from './exploration-policy-environment.mjs'

const root = process.argv[2], repo = fileURLToPath(new URL('../../', import.meta.url))
if (!root) throw new Error('Usage: exploration-policy-audit.mjs <study-root> [output.json]')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const lines = async path => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
const report = await json(join(root, 'report.json')), spec = await json(join(root, 'spec.json'))
assert.deepEqual(report.spec, spec)
for (const [path, digest] of Object.entries(spec.sourceHashes)) {
  const snapshot = await readFile(join(root, 'prepared-source', path), 'utf8').catch(() => undefined)
  assert.equal(sha(snapshot ?? await readFile(join(repo, path), 'utf8')), digest, path)
}
assert.equal(sha(await json(join(root, 'training.json'))), spec.trainingSha256)
const attempts = await lines(join(root, 'attempts.jsonl')), runs = await lines(join(root, 'runs.jsonl'))
assert.deepEqual(report.runs, runs)
assert.deepEqual(attempts.slice(0, runs.length).map(r => r.label), runs.map(r => r.label))
assert.ok(attempts.length - runs.length <= 1, 'Unexplained missing run records.')
assert.equal(new Set(runs.map(r => r.runId)).size, runs.length)
assert.equal(new Set(runs.map(r => r.label)).size, runs.length)
const paths = await readdir(join(root, 'runs'), { recursive: true }), transcripts = [], originalMessages = new Map()
for (const run of runs) {
  const found = paths.filter(p => p.endsWith(`/runs/${run.runId}/run.json`)); assert.equal(found.length, 1)
  const dir = join(root, 'runs', found[0].slice(0, -'run.json'.length)), record = await json(join(dir, 'run.json'))
  const events = await lines(join(dir, 'transcript.jsonl')), final = events.findLast(e => ['run_completed', 'run_failed'].includes(e.type))
  assert.ok(final)
  if (final.type === 'run_failed') { assert.equal(run.stopReason, 'error'); assert.equal(final.error, run.error) }
  else { assert.equal(final.result ?? '', run.output ?? ''); assert.equal(final.stopReason, run.stopReason) }
  assert.equal(record.tokenUsage.totalTokens, run.tokens)
  if (spec.live) {
    assert.equal(record.metadata.config.model, spec.model)
    assert.equal(record.metadata.provider, spec.provider ?? 'zen')
    assert.equal(record.metadata.config.effort ?? null, spec.effort ?? null)
    if (spec.version >= 2) { assert.equal(run.model, spec.model); assert.equal(run.provider, spec.provider); assert.equal(run.effort, spec.effort) }
  }
  const stored = await json(join(dir, 'messages.json')), visible = JSON.stringify(stored.messages)
  originalMessages.set(run.label, stored.messages)
  if (!run.label.endsWith('/predict')) {
    for (const e of [...spec.verification, ...spec.confirmation, ...spec.holdout]) {
      for (const r of e.tests) assert.ok(!visible.includes(r.id), 'Hidden prediction record reached proposal/explorer.')
    }
  }
  transcripts.push({ runId: run.runId, label: run.label, terminal: { type: final.type, stopReason: final.stopReason, error: final.error, providerError: final.providerError }, transcriptSha256: sha(await readFile(join(dir, 'transcript.jsonl'), 'utf8')),
    tools: events.filter(e => ['tool_executing','tool_completed'].includes(e.type)).map(({ type, toolName, input, result, isError, toolUseId }) => ({ type, toolName, input, result, isError, toolUseId })) })
}
const proposal = runs.find(r => r.label === 'propose-policy')
if (report.candidate) {
  assert.deepEqual(JSON.parse(proposal.output.replace(/^```(?:json)?\s*|\s*```$/g, '')), report.candidate)
  assert.equal(report.candidate.purpose, 'exploration')
}
const probes = await lines(join(root, 'probes.jsonl'))
for (const row of report.episodes) {
  const e = [...spec.verification, ...spec.confirmation, ...spec.holdout].find(e => e.id === row.episode); assert.ok(e)
  assert.deepEqual(e.expected, e.tests.map(r => preview(e.config, r)))
  assert.deepEqual(row.expected, e.expected)
  const explorer = runs.find(r => r.runId === row.explorerRunId), predictor = runs.find(r => r.runId === row.predictorRunId)
  assert.equal(row.tokens, explorer.tokens + predictor.tokens)
  assert.equal(row.output, predictor.output)
  const calls = probes.filter(p => p.label === row.label).map(({ label, ...p }) => p)
  assert.deepEqual(calls, row.calls)
  let used = 0
  for (const c of calls) {
    if (used + c.input.records.length <= spec.limits.records) {
      used += c.input.records.length
      if (c.success) assert.deepEqual(JSON.parse(c.output), c.input.records.map(input => ({ input, destination: preview(e.config, input) })))
    } else assert.equal(c.success, false)
  }
  assert.equal(row.probesUsed, used); assert.ok(used <= spec.limits.records)
  const tools = transcripts.find(t => t.runId === explorer.runId).tools
  for (const call of calls) {
    const executed = tools.find(t => t.type === 'tool_executing' && JSON.stringify(t.input) === JSON.stringify(call.input))
    assert.ok(executed)
    const result = tools.find(t => t.type === 'tool_completed' && t.toolUseId === executed.toolUseId)
    assert.ok(result); if (call.success) assert.equal(result.result, call.output)
  }
  const user = originalMessages.get(`${row.label}/predict`).find(m => m.role === 'user')
  const content = typeof user.content === 'string' ? user.content : user.content.filter(b => b.type === 'text').map(b => b.text).join('')
  assert.deepEqual(JSON.parse(content), { observations: calls.filter(c => c.success), records: e.tests })
  assert.equal(transcripts.find(t => t.runId === predictor.runId).tools.length, 0)
  assert.equal(row.policyHash, sha(['baseline', 'rollback'].includes(row.arm) ? baselinePolicy : report.candidate.body))
  let actual
  try { actual = JSON.parse(predictor.output.replace(/^```(?:json)?\s*|\s*```$/g, '')) } catch { actual = null }
  const correct = Array.isArray(actual) ? e.expected.filter((answer, i) => answer === actual[i]).length : 0
  assert.equal(row.correct, correct)
  assert.equal(row.complete, explorer.stopReason === 'end_turn' && predictor.stopReason === 'end_turn')
  assert.equal(row.passed, explorer.stopReason === 'end_turn' && predictor.stopReason === 'end_turn' && Array.isArray(actual) && actual.length === e.expected.length && correct === e.expected.length)
}
assert.equal(report.tokens, runs.reduce((n,r) => n+r.tokens,0))
const receipts = report.events.filter(e => e.kind === 'usage').map(e => e.data.receipt)
assert.equal(new Set(receipts.map(r => r.runId)).size, receipts.length)
assert.deepEqual(new Set(receipts.map(r => r.runId)), new Set(runs.filter(r => !r.label.startsWith('holdout-')).map(r => r.runId)))
for (const receipt of receipts) {
  const run = runs.find(r => r.runId === receipt.runId); assert.ok(run)
  assert.equal(receipt.tokens, run.usageComplete ? run.tokens : null)
  assert.equal(receipt.costUsd, run.usageComplete && run.cost?.unpricedTokens === 0 ? run.cost.totalCost : null)
}
const [projectId] = await readdir(join(root, 'home/residents')), binding = await json(join(root, 'home/residents', projectId, 'default/binding.json'))
const store = new sdk.SqliteResidentLearningStore({ databasePath: join(root, 'home/state/learning.sqlite'), artifactsPath: join(root, 'home/learning/artifacts'), scope: { ...binding, projectId }, readOnly: true })
const cycle = await store.get(report.cycle.cycleId)
const verification = await store.readArtifact(cycle.cycleId, 'verification').catch(() => undefined)
const confirmation = await store.readArtifact(cycle.cycleId, 'confirmation').catch(() => undefined)
let decision = null
if (verification) {
  const review = sdk.reviewHarnessCandidate(verification, confirmation, spec.protection); decision = review.decision
  for (const [stage, batch] of [['verification', verification], ['confirmation', confirmation]]) {
    if (!batch) continue
    for (const arm of ['baseline', 'candidate']) for (const trial of batch[arm]) {
      const row = report.episodes.find(r => r.predictorRunId === trial.trajectoryId)
      assert.ok(row); assert.equal(row.passed, trial.result.passed)
      assert.equal(row.tokens, trial.result.run.totalTokens)
      const episode = spec[stage].find(e => e.id === row.episode)
      assert.equal(trial.conditions, sha({ episode, limits: spec.limits,
        ...(spec.version >= 2 ? { provider: spec.provider } : {}), model: spec.model,
        effort: spec.effort ?? null, baselinePolicy, predictionInstructions }))
    }
    assert.equal(report.episodes.filter(r => r.episode.startsWith(stage)).length, 20)
  }
}
assert.equal(report.events[0].data.purpose, 'exploration')
assert.deepEqual(report.events[0].data.protection, spec.protection)
if (cycle.status === 'activated') {
  assert.equal(decision, 'accept')
  const agenda = new sdk.DiskResidentAgenda(join(root, 'home/residents', projectId), binding)
  const state = await agenda.readRevision(cycle.result.agendaRevision)
  assert.deepEqual(sdk.projectResidentLearning(state.learning, { maxChars: 8000, skillNames: [skillName] }).includedSkills, [])
  assert.deepEqual(sdk.projectResidentLearning(state.learning, { maxChars: 8000, skillNames: [skillName], purpose: 'exploration' }).includedSkills, [skillName])
  assert.deepEqual((await agenda.read()).learning.skills, [])
  assert.equal(report.episodes.filter(e => e.arm === 'reopened').length, 3)
  assert.equal(report.episodes.filter(e => e.arm === 'rollback').length, 3)
} else assert.deepEqual(report.active, [])
const comparablePairs = spec.verification.flatMap(e => {
  const rows = report.episodes.filter(r => r.episode === e.id && r.complete)
  const baseline = rows.find(r => r.arm === 'baseline'), candidate = rows.find(r => r.arm === 'candidate')
  return baseline && candidate ? [{ episode: e.id, baselineCorrect: baseline.correct, candidateCorrect: candidate.correct, count: e.tests.length }] : []
})
const audit = { ...report, audit: { verifiedRetainedEvidence: true, settledAttempts: runs.length, attemptedRuns: attempts.length,
  comparableVerificationPairs: comparablePairs,
  unknownRuns: report.unknownRuns, reportSha256: sha(await readFile(join(root, 'report.json'), 'utf8')), decision,
  predictorInstructionsSha256: sha(predictionInstructions), transcripts,
  toolErrors: transcripts.flatMap(t => t.tools).filter(t => t.type === 'tool_completed' && t.isError).length } }
const out = process.argv[3] ?? join(root, 'audited.json')
await writeFile(out, `${JSON.stringify(audit, null, 2)}\n`)
console.log(JSON.stringify({ out, status: cycle.status, decision, rounds: report.rounds, runs: runs.length, tokens: report.tokens, toolErrors: audit.audit.toolErrors }))
