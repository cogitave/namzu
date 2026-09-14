// Read-only audit of an isolated producer directory. No model/provider initialization.
import assert from 'node:assert/strict'
import { observesCurrentSource, scoreSourceObservation } from './tool-learning-evidence.mjs'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SqliteResidentLearningStore,
  DiskResidentAgenda,
  hashResidentSkill,
  reviewHarnessCandidate,
} from '../../packages/sdk/dist/index.js'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const normalize = (value) => (value ?? '').trim().replace(/^['"`]|['"`]$/g, '')

export async function auditToolLearning(root) {
  const reportBytes = await readFile(join(root, 'result.json'))
  const report = JSON.parse(reportBytes)
  const spec = JSON.parse(await readFile(join(root, 'study.json')))
  const raw = await readFile(join(root, 'runs.jsonl'), 'utf8')
  const runs = raw.trim().split('\n').filter(Boolean).map(JSON.parse)
  assert.equal(new Set(runs.map((r) => r.runId)).size, runs.length)
  const [projectId] = await readdir(join(root, 'home/residents'))
  const binding = JSON.parse(
    await readFile(join(root, 'home/residents', projectId, 'default/binding.json')),
  )
  const store = new SqliteResidentLearningStore({
    databasePath: join(root, 'home/state/learning.sqlite'),
    artifactsPath: join(root, 'home/learning/artifacts'),
    scope: { ...binding, projectId },
    readOnly: true,
  })
  const cycle = (await store.list())[0]
  assert.ok(cycle)
  const events = []
  for (let after = 0; ; ) {
    const page = await store.events(cycle.cycleId, { after, limit: 256 })
    events.push(...page)
    if (page.length < 256) break
    after = page.at(-1).sequence
  }
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, i) => i + 1),
  )
  assert.equal(events.length, cycle.sequence)
  const receipts = events.filter((e) => e.kind === 'usage').map((e) => e.data.receipt)
  assert.equal(new Set(receipts.map((r) => r.runId.toLowerCase())).size, receipts.length)
  assert.deepEqual(cycle.recordedUsage, {
    tokens: receipts.reduce((n, r) => n + (r.tokens ?? 0), 0),
    costUsd: receipts.reduce((n, r) => n + (r.costUsd ?? 0), 0),
    receipts: receipts.length,
    unknownTokens: receipts.filter((r) => r.tokens === null).length,
    unknownCosts: receipts.filter((r) => r.costUsd === null).length,
  })
  for (const receipt of receipts) {
    const run = runs.find((r) => r.runId === receipt.runId)
    assert.ok(run)
    assert.equal(receipt.tokens, (run.evidenceVersion === 2 ? run.usageComplete : run.stopReason === 'end_turn') ? run.tokens : null)
  }
  const artifacts = await store.artifacts(cycle.cycleId)
  const retained = {}
  for (const artifact of artifacts)
    retained[artifact.name] = await store.readArtifact(cycle.cycleId, artifact.name)
  for (const run of runs.filter((r) => receipts.some((x) => x.runId === r.runId))) {
    // A crash between receipt and artifact can leave a receipt without a blob; report, don't fabricate.
    if (retained[`run-${run.runId}`]) assert.deepEqual(retained[`run-${run.runId}`], run)
  }
  const scored = []
  const batch = {}
  for (const phase of ['verification', 'confirmation']) {
    const reports = retained[`${phase}-all-arms`]
    if (!reports) continue
    batch[phase] = retained[phase]
    const ev = events.find((e) => e.kind === 'evaluation' && e.stage === phase)
    if (ev) assert.equal(ev.data.digest, sha(JSON.stringify(batch[phase])))
    for (const arm of ['frozen', 'memory', 'guidance']) {
      const cases = reports[arm].cases
      let correct = 0,
        grounded = 0,
        ended = 0
      for (const c of cases) {
        const fixture = spec[phase].find((f) => f.id === c.case)
        assert.ok(fixture)
        const run = runs.find((r) => r.label === `${phase}/${arm}/${fixture.id}`)
        assert.ok(run)
        const exact = normalize(run.output) === fixture.expected
        const read = run.tools.some(
          (t) =>
            t.success &&
            t.name === 'read' &&
            [fixture.source, join(fixture.cwd, fixture.source)].includes(t.input.path),
        )
        const observedSource = run.evidenceVersion === 2 ? observesCurrentSource(run.tools, fixture) : read
        correct += Number(exact)
        grounded += Number(exact && observedSource)
        ended += Number(run.stopReason === 'end_turn')
        // Evaluation may have a timeout before a trace; don't treat unavailable scoring as a pass.
        const score = c.scores?.['observed-source']
        if (score?.details && 'correct' in score.details) {
          assert.equal(score.details.correct, exact)
          if (run.evidenceVersion === 2) {
            const rescored = scoreSourceObservation({ output: run.output, toolCalls: run.tools, stopReason: run.stopReason }, { input: fixture, expected: fixture.expected })
            assert.deepEqual(score, rescored)
          } else {
            assert.equal(score.details.read, read)
            assert.equal(score.score, Number(exact && read))
          }
        } else if (score?.details?.error) {
          assert.equal(score.score, 0)
          assert.equal(c.status, 'failed')
          assert.ok(score.reason.startsWith('run failed:'))
        }
        assert.equal(c.passed, Boolean(score && score.score === 1 && c.status === 'passed'))
      }
      const measured = runs.filter((r) => r.label.startsWith(`${phase}/${arm}/`))
      scored.push({
        phase,
        arm,
        cases: cases.length,
        correct,
        grounded,
        ended,
        tokens: measured.reduce((n, r) => n + r.tokens, 0),
      })
    }
  }
  if (cycle.status === 'activated') {
    assert.equal(cycle.result.candidateRevision, hashResidentSkill(cycle.result.candidate))
    assert.equal(reviewHarnessCandidate(batch.verification, batch.confirmation).decision, 'accept')
  }
  const held = (report.holdout ?? []).map((h) => {
    const run = runs.find((r) => r.runId === h.runId)
    assert.ok(run)
    assert.equal(h.correct, run.output?.trim() === h.expected)
    return { arm: h.arm, id: h.id, correct: h.correct }
  })
  const controls = (report.controls ?? []).map((c) => {
    const run = runs.find((r) => r.runId === c.runId)
    assert.ok(run)
    assert.equal(c.correct, run.output?.trim() === c.expected)
    return { arm: c.arm, correct: c.correct, stopReason: run.stopReason }
  })
  const agenda = await new DiskResidentAgenda(
    join(root, 'home/residents', projectId),
    binding,
  ).read()
  if (report.rollback?.performed) {
    assert.deepEqual(agenda.learning.skills, [])
    assert.deepEqual(report.rollback.activeSkills, [])
  }
  const cli = report.cliInspection?.inspection
  if (report.cliObserved) {
    assert.equal(report.cliObserved.phase, 'complete')
    assert.equal(report.cliObserved.summary, report.cliObserved.expected)
    assert.equal(cli.usageComplete, true)
  }
  if (report.buildAfter) assert.deepEqual(report.buildAfter, report.buildBefore)
  const fixtures = [
    spec.seed,
    spec.admission,
    ...spec.verification,
    ...spec.confirmation,
    ...spec.held,
  ]
  const generatedInFixtures = []
  for (const f of fixtures)
    if ((await readdir(f.cwd)).includes('.namzu')) generatedInFixtures.push(f.id)
  return {
    root,
    live: report.live,
    model: report.model,
    effort: report.effort,
    producerCompleted: report.completed ?? false,
    producerError: report.error ?? null,
    sourceReportSha256: sha(reportBytes),
    runsSha256: sha(raw),
    cycleId: cycle.cycleId,
    status: cycle.status,
    auditComplete: cycle.result?.auditComplete ?? false,
    recordedUsage: cycle.recordedUsage,
    artifactsVerified: artifacts.length,
    events: events.length,
    receiptArtifactsMissing: receipts.filter((r) => !retained[`run-${r.runId}`]).length,
    sdkRuns: runs.length,
    sdkTokens: runs.reduce((n, r) => n + r.tokens, 0),
    unpricedSdkTokens: runs.reduce((n, r) => n + (r.cost?.unpricedTokens ?? r.tokens), 0),
    cliTokens: cli?.recorded?.ownTokens ?? 0,
    cliUnpricedTokens: cli?.recorded?.unpricedOwnTokens ?? 0,
    incompleteRuns: runs
      .filter((r) => r.stopReason !== 'end_turn')
      .map((r) => ({ label: r.label, reason: r.stopReason, recordedTokens: r.tokens })),
    scored,
    heldout: held,
    controls,
    cliObserved: report.cliObserved ?? null,
    rollback: report.rollback
      ? {
          performed: report.rollback.performed,
          activeSkills: report.rollback.activeSkills.length,
          observation: report.rollback.observation?.output,
        }
      : null,
    generatedStateInFixtures: generatedInFixtures,
    limits: report.limits ?? { caseTokens: 6000, caseIterations: 6 },
    build: report.buildBefore,
    producerHashes: report.producerHashes ?? null,
    evidenceConsistent: true,
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await auditToolLearning(process.argv[2])
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
