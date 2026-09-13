// Re-audit closed records. No model requests, state mutations or provider imports.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hashResidentSkill, reviewHarnessCandidate } from '../../packages/sdk/dist/index.js'

export async function auditLearningCycle(root) {
  const bytes = await readFile(join(root, 'result.json'))
  const report = JSON.parse(bytes)
  assert.equal(report.completed, true, 'The producer did not complete.')
  assert.equal(report.error, undefined)
  assert.deepEqual(report.buildAfter, report.buildBefore)
  assert.equal(report.cycle.status, 'activated')
  assert.equal(report.cycle.auditComplete, true)
  assert.equal(report.cycle.candidateRevision, hashResidentSkill(report.cycle.candidate))
  const events = (await readFile(join(root, 'cycle.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(events.map(e => e.sequence), events.map((_, i) => i + 1))
  assert.ok(events.every(e => e.cycleId === report.cycle.cycleId))
  assert.equal(events[0].kind, 'started')
  assert.equal(events.at(-1).kind, 'finished')
  const receipts = events.filter(e => e.kind === 'usage').map(e => e.data.receipt)
  assert.equal(new Set(receipts.map(r => r.runId.toLowerCase())).size, receipts.length)
  assert.equal(receipts.length, report.cycle.consumption.receipts)
  assert.equal(receipts.reduce((n, r) => n + (r.tokens ?? 0), 0), report.cycle.consumption.tokens)
  assert.equal(receipts.filter(r => r.costUsd === null).length, report.cycle.consumption.unknownCosts)
  assert.equal(report.cycle.consumption.unfinishedStages, 0)
  assert.equal(events.filter(e => e.kind === 'stage-finished').length, 3)
  const rawRuns = (await readFile(join(root, 'runs.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.deepEqual(rawRuns, report.runs)
  assert.equal(new Set(rawRuns.map(r => r.runId)).size, rawRuns.length)
  assert.ok(rawRuns.every(r => r.stopReason === 'end_turn'))
  assert.equal(rawRuns.length, report.sdkCalls)
  assert.equal(rawRuns.reduce((n, r) => n + r.usage.totalTokens, 0), report.recordedSdkTokens)
  for (const receipt of receipts) {
    const run = rawRuns.find(r => r.runId === receipt.runId)
    assert.ok(run, 'Every experiment charge must join a retained SDK run.')
    assert.equal(receipt.tokens, run.usage.totalTokens)
    assert.equal(receipt.costUsd, run.costInfo.unpricedTokens === 0 ? run.costInfo.totalCost : null)
  }
  const rounds = {}
  const scored = []
  for (const phase of ['verification', 'confirmation']) {
    const data = JSON.parse(await readFile(join(root, `${phase}.json`), 'utf8'))
    const event = events.find(e => e.kind === 'evaluation' && e.stage === phase)
    assert.equal(event.data.digest, createHash('sha256').update(JSON.stringify(data.batch)).digest('hex'))
    rounds[phase] = data.batch
    for (const arm of ['frozen', 'memory', 'guidance']) {
      const outcomes = data.reports[arm].cases
      for (const c of outcomes) {
        const s = c.scores['exact-destination']
        assert.equal(s.score, Number(s.details.observed === s.details.expected))
        assert.equal(c.passed, s.score === 1)
        assert.equal(c.run.output.trim(), s.details.observed)
      }
      const runs = rawRuns.filter(r => r.label.startsWith(`${phase}/${arm}/`))
      assert.equal(outcomes.length, runs.length)
      assert.deepEqual(outcomes.map(c => c.run.output), runs.map(r => r.output))
      scored.push({ phase, arm, correct: outcomes.filter(c => c.passed).length, total: outcomes.length, tokens: runs.reduce((n, r) => n + r.usage.totalTokens, 0) })
    }
  }
  assert.equal(reviewHarnessCandidate(rounds.verification, rounds.confirmation).decision, 'accept')
  assert.ok(report.commands.every(c => c.exit === 0))
  assert.deepEqual(report.rollback.activeSkills, [])
  assert.equal(report.rollback.observedUnknown, true)
  assert.equal(report.finalAgenda.learning.skills.length, 0)
  const cli = report.cliInspection?.inspection
  if (report.live) {
    assert.equal(report.provider, 'zen')
    assert.equal(report.model, 'muse-spark-1.3-contributor-free')
    assert.equal(report.effort, 'low')
    assert.equal(report.cliAdmission.phase, 'complete')
    assert.equal(report.cliAdmission.summary, report.cliAdmission.expected)
    assert.equal(cli.attempts.length, 1)
    assert.equal(cli.usageComplete, true)
    // External experiment check, never relabel this as a kernel claim receipt.
    assert.equal(cli.attempts[0].receipt.verification, 'unconfigured')
    const state = report.cliAdmission.result.agenda
    assert.equal(state.learning.skills[0].hash, report.cycle.candidateRevision)
    assert.equal(state.learning.skills[0].evidence.key, report.cycle.cycleId)
  }
  for (const held of report.holdout) {
    const run = rawRuns.find(r => r.runId === held.runId)
    assert.ok(run)
    assert.equal(held.passed, run.output.trim() === held.expected)
  }
  const holdout = ['frozen', 'memory', 'guidance'].map(arm => ({ arm, correct: report.holdout.filter(h => h.arm === arm && h.passed).length, total: report.holdout.filter(h => h.arm === arm).length }))
  return {
    root, live: report.live, model: report.model, effort: report.effort,
    sourceReportSha256: createHash('sha256').update(bytes).digest('hex'),
    elapsedMs: report.finishedAt - report.startedAt,
    cycle: report.cycle, scored, holdout, sdkRuns: report.sdkCalls,
    sdkTokens: report.recordedSdkTokens, unpricedSdkTokens: report.unpricedSdkTokens,
    cliTokens: cli?.recorded.ownTokens ?? 0, cliUnpricedTokens: cli?.recorded.unpricedOwnTokens ?? 0,
    cliAdmission: report.cliAdmission ? { phase: report.cliAdmission.phase, summary: report.cliAdmission.summary, expected: report.cliAdmission.expected } : null,
    rollback: report.rollback, build: report.buildBefore, passed: true,
    limitations: report.limitations,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await auditLearningCycle(process.argv[2])
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
