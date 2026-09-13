// --live uses only Zen Muse low. Without it, every inference result is an explicit fixture.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as sdk from '../../packages/sdk/dist/index.js'

const live = process.argv.includes('--live')
const model = 'muse-spark-1.3-contributor-free'
const { ZenProvider } = live ? await import('../../packages/providers/zen/dist/index.js') : {}
const repo = fileURLToPath(new URL('../../', import.meta.url))
const cli = join(repo, 'packages/cli/dist/bin.js')
const root = await mkdtemp(join(tmpdir(), 'namzu-learning-cycle-'))
const cwd = join(root, 'workspace'), home = join(root, 'home')
await mkdir(cwd, { mode: 0o700 }); await mkdir(home, { mode: 0o700 })
const env = { ...process.env, NAMZU_HOME: home }
await writeFile(join(home, 'preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }))
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
const report = { root, live, provider: live ? 'zen' : 'mock', model: live ? model : 'mock-model', effort: 'low', startedAt: Date.now(), runs: [], commands: [], rounds: [], limits: { maximumSdkCalls: 80, tokensPerCall: 2400, millisecondsPerCall: 45000, experimentMilliseconds: 900000 } }
const signal = AbortSignal.timeout(report.limits.experimentMilliseconds)
const digest = value => createHash('sha256').update(value).digest('hex')
const buildFiles = ['packages/sdk/dist/manager/resident/learning-cycle.js', 'packages/sdk/dist/manager/resident/learning.js', 'packages/sdk/dist/eval/harness-verification.js', 'packages/cli/dist/integrations/resident/session-step.js', 'packages/providers/zen/dist/client.js']
const fingerprint = async () => Object.fromEntries(await Promise.all(buildFiles.map(async file => [file, digest(await readFile(join(repo, file)))])))
report.buildBefore = await fingerprint()
const persist = () => writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
const append = async (file, value) => {
  const fd = await open(join(root, file), 'a', 0o600)
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync() } finally { await fd.close() }
}
const exec = promisify(execFile)
const command = async args => {
  try {
    const { stdout } = await exec(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', cwd], { cwd, env, signal, timeout: 120000, maxBuffer: 1024 * 1024 })
    const result = JSON.parse(stdout)
    report.commands.push({ args, exit: 0, result }); await persist(); return result
  } catch (error) {
    report.commands.push({ args, exit: error.code, stdout: error.stdout, stderr: error.stderr }); await persist(); throw error
  }
}

// This workspace-specific convention is the host's declared oracle. It is not a
// hidden benchmark answer learned during model training. Cold behavior lacks it.
const convention = 'Preserve id exactly, including case and leading zeros. If sealed is true, the destination is hold/<id>.json, regardless of kind. Otherwise invoice goes to finance/<year>/<month padded to two digits>/<id>.json; memo goes to notes/<year>/<id>.md. Return only the path, without quoting or explanation.'
const route = r => r.sealed ? `hold/${r.id}.json` : r.kind === 'invoice' ? `finance/${r.year}/${String(r.month).padStart(2, '0')}/${r.id}.json` : `notes/${r.year}/${r.id}.md`
const record = (id, kind, sealed, month = 3, year = 2031) => ({ id, kind, sealed, month, year })
const families = prefix => [record(`${prefix}MiX`, 'invoice', false), record(`00${prefix}`, 'memo', false), record(`${prefix}-sealed`, 'invoice', true), record(`${prefix}-note`, 'memo', true), record(`${prefix}-dec`, 'invoice', false, 12)]
const cases = phase => families(phase).flatMap((r, i) => [0, 1].map(trial => ({ name: `${phase}-${i}-${trial}`, taskId: `${phase}-${i}`, trial, input: { ...r, id: `${r.id}${trial}`, year: r.year + trial }, expected: route({ ...r, id: `${r.id}${trial}`, year: r.year + trial }) })))
// Declare all task sets before observing the generated candidate.
const suites = { verification: cases('verification'), confirmation: cases('confirmation'), holdout: cases('holdout').slice(0, 4) }
await writeFile(join(root, 'private-oracle.json'), JSON.stringify({ convention, suites }, null, 2))
const normalize = text => (text ?? '').trim().replace(/^```(?:text)?\s*\n([\s\S]*?)\n```$/u, '$1').trim()
const settings = guidance => `You route records under a workspace convention. Use the supplied experience or active guidance when available. If no convention is available, return UNKNOWN; do not invent one. Return only the destination path.\n${guidance}`
let calls = 0
const ask = async ({ label, instructions, prompt, scripted, context, abort = signal }) => {
  abort.throwIfAborted()
  assert.ok(++calls <= report.limits.maximumSdkCalls, 'Experiment call allowance exceeded.')
  await append('attempts.jsonl', { label, phase: 'started', at: Date.now(), sdkAttempt: calls })
  const started = performance.now()
  const runResult = await sdk.runAgent({
    provider: live ? new ZenProvider({ model }) : sdk.ProviderRegistry.create({ type: 'mock', responseText: scripted }).provider,
    model: live ? model : 'mock-model', effort: 'low', signal: abort,
    workingDirectory: cwd, maxIterations: 1, tokenBudget: report.limits.tokensPerCall,
    timeoutMs: report.limits.millisecondsPerCall, instructions, prompt, tools: new sdk.ToolRegistry(),
  })
  const r = runResult.run
  const retained = { label, runId: r.id, output: runResult.output, stopReason: r.stopReason, usage: r.tokenUsage, costInfo: r.costInfo, durationMs: performance.now() - started }
  report.runs.push(retained)
  await append('runs.jsonl', retained)
  await append('attempts.jsonl', { label, phase: 'returned', at: Date.now(), runId: r.id })
  if (context) await context.recordUsage({ runId: r.id, tokens: r.stopReason === 'end_turn' ? r.tokenUsage.totalTokens : null, costUsd: r.stopReason === 'end_turn' && r.costInfo?.unpricedTokens === 0 ? r.costInfo.totalCost : null })
  if (r.stopReason !== 'end_turn') throw new Error(`${label} ended with ${r.stopReason}.`)
  return retained
}

let agenda
try {
  console.log(JSON.stringify({ root, live, model: report.model }))
  const cliInput = record('ReOpened-07', 'invoice', false, 8, 2033)
  await command(['add', '--trust', `Using retained workspace routing guidance, route this record: ${JSON.stringify(cliInput)}. Complete with only its destination path as the summary. Do not read or change files, run commands, or create agents.`])
  const [project] = await readdir(join(home, 'residents'))
  const binding = JSON.parse(await readFile(join(home, 'residents', project, 'default', 'binding.json'), 'utf8'))
  agenda = new sdk.DiskResidentAgenda(join(home, 'residents', project), binding)
  const initial = await agenda.read()
  const seedInput = record('Seed-01', 'invoice', false, 2)
  const cold = await ask({ label: 'cold', instructions: settings(''), prompt: JSON.stringify(seedInput), scripted: 'UNKNOWN' })
  const trace = JSON.stringify({ input: seedInput, observed: cold.output, expected: route(seedInput), correction: convention })
  assert.notEqual(normalize(cold.output), route(seedInput), 'This fixture needs an observed cold knowledge gap.')
  const skillName = 'workspace-routing'
  const batches = {}
  report.cycle = await sdk.runResidentLearningCycle({
    agenda, skillName, signal,
    failure: { evidence: { key: cold.runId, source: 'workspace-routing-oracle/v1', reason: 'Cold output did not meet the host routing convention; the host supplied the corrective contract.' }, trace },
    resources: { unit: 'tokens', maxUnits: 180000 },
    record: event => append('cycle.jsonl', event),
    generate: async context => {
      const r = await ask({ label: 'generate', context, instructions: 'Derive reusable workspace routing guidance from the observed failure and authoritative correction. Return only JSON with name, description, body. The name must be workspace-routing. Generalize the rules; do not encode the example ID or claim evaluation success. Keep the body under 2000 characters.', prompt: context.failure.trace, scripted: JSON.stringify({ name: skillName, description: 'Apply the learned workspace destination convention.', body: convention }) })
      const candidate = JSON.parse(r.output.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/u, '$1'))
      return { candidate, usageComplete: true }
    },
    evaluate: async context => {
      const phase = context.stage, fixtures = suites[phase]
      const reports = {}
      // Same model/tools/settings; each run has an empty chat history. The memory
      // arm measures whether guidance adds anything over retaining the raw correction.
      for (const arm of ['frozen', 'memory', 'guidance']) {
        const guidance = arm === 'memory' ? `Retained experience: ${trace}` : arm === 'guidance' ? `Active guidance: ${context.candidate.body}` : context.baseline?.body ?? ''
        reports[arm] = await sdk.runExperiment({
          name: `${phase}/${arm}`, cases: fixtures, concurrency: 1, timeoutMs: 50000, passThreshold: 1,
          run: async (input, _fixture, caseSignal) => {
            const r = await ask({ label: `${phase}/${arm}/${input.id}`, context, abort: AbortSignal.any([signal, caseSignal]), instructions: settings(guidance), prompt: JSON.stringify(input), scripted: guidance ? route(input) : 'UNKNOWN' })
            return { output: r.output, steps: [], toolCalls: [], stopReason: r.stopReason, totalTokens: r.usage.totalTokens, totalCostUsd: r.costInfo?.totalCost ?? 0, durationMs: r.durationMs }
          },
          scorers: [{ name: 'exact-destination', severity: 'gate', threshold: 1, score: (run, fixture) => ({ score: Number(normalize(run.output) === fixture.expected), reason: `Observed ${JSON.stringify(normalize(run.output))}; expected ${JSON.stringify(fixture.expected)}.`, details: { observed: normalize(run.output), expected: fixture.expected } }) }],
        })
      }
      const trials = arm => reports[arm].cases.map((result, i) => ({ taskId: fixtures[i].taskId, trial: fixtures[i].trial, conditions: digest(JSON.stringify({ phase, input: fixtures[i].input, model: report.model, effort: 'low', tools: [] })), trajectoryId: `${phase}/${arm}/${i}`, result }))
      const baseline = trials('frozen'), candidate = trials('guidance')
      const attributions = [...new Set(fixtures.map(f => f.taskId))].flatMap(taskId => {
        const before = baseline.filter(t => t.taskId === taskId), after = candidate.filter(t => t.taskId === taskId)
        const b = before.filter(t => t.result.passed).length, c = after.filter(t => t.result.passed).length
        return b === c ? [] : [{ taskId, effect: c > b ? 'improvement' : 'regression', reason: `External exact-destination oracle compared retained outputs under matching model/tools; baseline ${b}/2, guidance ${c}/2. Only admitted guidance changed.`, baselineTrajectories: before.map(t => t.trajectoryId), candidateTrajectories: after.map(t => t.trajectoryId) }]
      })
      const batch = { baselineRevision: context.baselineRevision, candidateRevision: context.candidateRevision, baseline, candidate, attributions }
      batches[phase] = batch
      await writeFile(join(root, `${phase}.json`), JSON.stringify({ reports, batch }, null, 2))
      report.rounds.push({ phase, scores: Object.fromEntries(Object.entries(reports).map(([arm, r]) => [arm, { passed: r.passed, failed: r.failed, inconclusive: r.inconclusive, uncertainty: r.uncertainty }])) })
      console.log(JSON.stringify(report.rounds.at(-1)))
      await persist()
      return { batch, usageComplete: Object.values(reports).every(r => r.cases.every(c => !c.run.error && c.run.stopReason === 'end_turn')) }
    },
  })
  console.log(JSON.stringify({ cycle: report.cycle.status, tokens: report.cycle.consumption.tokens }))
  const reopened = new sdk.DiskResidentAgenda(join(home, 'residents', project), binding)
  const state = await reopened.read()
  if (report.cycle.status === 'activated') {
    const active = state.learning.skills.find(s => s.name === skillName)
    assert.equal(active.hash, report.cycle.candidateRevision)
    report.holdout = []
    for (const fixture of suites.holdout) for (const arm of ['frozen', 'memory', 'guidance']) {
      const guidance = arm === 'memory' ? `Retained experience: ${trace}` : arm === 'guidance' ? active.body : ''
      const r = await ask({ label: `holdout/${arm}/${fixture.input.id}`, instructions: settings(guidance), prompt: JSON.stringify(fixture.input), scripted: guidance ? route(fixture.input) : 'UNKNOWN' })
      report.holdout.push({ arm, task: fixture.name, passed: normalize(r.output) === fixture.expected, expected: fixture.expected, runId: r.runId })
    }
    if (live) {
      const result = await command(['run', '--trust', '--max-steps', '1', '--max-iterations', '3', '--token-budget', '16000', '--provider', 'zen', '--model', model, '--effort', 'low'])
      const status = await command(['status'])
      const pursuit = status.agenda.pursuits[0]
      report.cliAdmission = { phase: pursuit.state.phase, summary: pursuit.state.summary, expected: route(cliInput), result }
      assert.equal(pursuit.state.phase, 'complete')
      assert.equal(normalize(pursuit.state.summary), route(cliInput))
      report.cliInspection = await command(['inspect'])
    }
    await reopened.rollbackSkill(await reopened.read(), skillName, initial.revision, { key: randomUUID(), source: 'experiment:rollback', reason: 'Verify explicit removal after the held-out observation.' })
    assert.equal((await reopened.read()).learning.skills.length, 0)
    const projection = sdk.projectResidentLearning((await reopened.read()).learning, { maxChars: 4000, skillNames: [skillName] })
    const rolledBack = await ask({ label: 'after-rollback', instructions: settings(projection.text), prompt: JSON.stringify(cliInput), scripted: 'UNKNOWN' })
    report.rollback = { activeSkills: projection.includedSkills, output: rolledBack.output, observedUnknown: normalize(rolledBack.output) === 'UNKNOWN' }
    assert.ok(report.rollback.observedUnknown)
  }
  report.buildAfter = await fingerprint(); assert.deepEqual(report.buildAfter, report.buildBefore)
  report.finishedAt = Date.now()
  report.sdkCalls = calls
  report.recordedSdkTokens = report.runs.reduce((n, r) => n + r.usage.totalTokens, 0)
  report.unpricedSdkTokens = report.runs.reduce((n, r) => n + (r.costInfo?.unpricedTokens ?? r.usage.totalTokens), 0)
  report.completed = true
  report.limitations = 'Synthetic workspace convention, supplied as authoritative host correction after an observed cold gap. Candidate text is model-generated only in --live. Frozen/memory/guidance are independent fresh runs. Acceptance compares guidance with frozen behavior; the memory arm can explain the same gain. No proof of advantage over raw memory, broad generalization or recursive improvement. CLI completion is checked by this experiment, not a configured resident verification policy. SDK totals exclude the separately reported CLI inspection.'
} catch (error) {
  report.error = String(error); report.finishedAt = Date.now(); report.completed = false
  process.exitCode = 1
} finally {
  report.sdkCalls = calls
  report.recordedSdkTokens = report.runs.reduce((n, r) => n + r.usage.totalTokens, 0)
  report.unpricedSdkTokens = report.runs.reduce((n, r) => n + (r.costInfo?.unpricedTokens ?? r.usage.totalTokens), 0)
  if (agenda) report.finalAgenda = await agenda.read()
  await persist()
  console.log(JSON.stringify({ root, completed: report.completed, cycle: report.cycle?.status, error: report.error, sdkCalls: calls, recordedSdkTokens: report.recordedSdkTokens }))
}
