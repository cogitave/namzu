import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sdk from '../../packages/sdk/dist/index.js'
import { fixtures } from './autonomous-environment.mjs'
import { runCase, sha } from './autonomous-learning-host.mjs'
import { model } from './tool-learning-host.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)), cli = join(repo, 'packages/cli/dist/bin.js')
const args = process.argv.slice(2), rootArg = flag => args[args.indexOf(flag) + 1]

async function command(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', join(root, 'workspace')],
      { cwd: join(root, 'workspace'), env: { ...process.env, NAMZU_HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      writeFile(join(root, `command-${args[0]}-${Date.now()}.json`), JSON.stringify({ args, code, stdout, stderr }, null, 2))
        .then(() => { try { resolve({ code, result: JSON.parse(stdout) }) } catch (error) { reject(error) } }, reject)
    })
  })
}

export async function inspect(root) {
  const spec = JSON.parse(await readFile(join(root, 'spec.json')))
  const [projectId] = await readdir(join(root, 'home/residents'))
  const binding = JSON.parse(await readFile(join(root, 'home/residents', projectId, 'default/binding.json')))
  const store = new sdk.SqliteResidentLearningStore({ databasePath: join(root, 'home/state/learning.sqlite'), artifactsPath: join(root, 'home/learning/artifacts'), scope: { ...binding, projectId }, readOnly: true })
  const agenda = new sdk.DiskResidentAgenda(join(root, 'home/residents', projectId), binding)
  const state = await agenda.read(), cycles = await store.list(), cycle = cycles[0]
  const lines = async name => (await readFile(join(root, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
  const runs = await lines('runs.jsonl'), scored = await lines('scored.jsonl')
  const events = cycle ? await store.events(cycle.cycleId, { limit: 256 }) : []
  const rounds = Object.fromEntries(['verification', 'confirmation', 'holdout'].map(phase => [phase,
    Object.fromEntries(['baseline', 'memory', 'candidate', 'reopened', 'rollback'].map(arm => {
      const rs = scored.filter(r => r.case.startsWith(phase) && r.arm === arm)
      return [arm, { passed: rs.filter(r => r.passed).length, count: rs.length, tokens: rs.reduce((n, r) => n + r.tokens, 0) }]
    }))]))
  const report = { root, live: spec.live, model: spec.live ? model : 'mock-model', effort: 'low', spec,
    cycle, events, active: state.learning?.skills ?? [], rounds, runs, scored,
    candidate: JSON.parse(await readFile(join(root, 'candidate.json')).catch(() => 'null')),
    observations: JSON.parse(await readFile(join(root, 'observations.json')).catch(() => 'null')),
    recordedTokens: runs.reduce((n, r) => n + r.tokens, 0), unknownReceipts: runs.filter(r => !r.usageComplete).length,
    limitations: 'Synthetic black-box service, not a general intelligence or RSI benchmark. Live probes are chosen by Muse; only scripted controls use fixed probes/answers. Cold task and evaluation rules are host-defined; no correct answer or correction reaches exploration/generation. Evaluation predicts withheld service outputs without preview access in any arm. Raw-memory control distinguishes experience retention from guidance benefit. All attempts and unknown prices retained. Reopened checks reuse accepted text; this does not demonstrate meta-learner improvement.' }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  return { report, agenda, state }
}

if (args.includes('--prepare')) {
  const root = await mkdtemp(join(tmpdir(), 'namzu-autonomous-learning-'))
  await mkdir(join(root, 'home'), { mode: 0o700 }); await mkdir(join(root, 'workspace'))
  const seed = randomUUID(), verification = fixtures(seed, 'verification'), confirmation = fixtures(seed, 'confirmation')
  const spec = { version: 1, live: args.includes('--live'), environmentSeed: seed, createdAt: Date.now(),
    limits: { iterations: 8, tokens: 24000, timeoutMs: 120000, exploratoryRecords: 24 },
    scorer: 'exact-preview-output-and-input-read-v1', seed: fixtures(seed, 'seed')[0], verification, confirmation,
    holdout: fixtures(seed, 'holdout').filter(f => ['invoice', 'memo', 'notice'].includes(f.family) && !f.trial),
    protection: { verification: ['verification-document', 'verification-sum'], confirmation: ['confirmation-document', 'confirmation-sum'] } }
  spec.sourceHashes = Object.fromEntries(await Promise.all(['research/resident/autonomous-learning-host.mjs', 'research/resident/autonomous-environment.mjs', 'research/resident/autonomous-learning-study.mjs', 'packages/sdk/dist/manager/resident/learning-cycle.js'].map(async p => [p, sha(await readFile(join(repo, p), 'utf8'))])))
  await writeFile(join(root, 'spec.json'), JSON.stringify(spec, null, 2))
  await writeFile(join(root, 'home/preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }))
  await writeFile(join(root, 'home/config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
  await writeFile(join(root, 'experiment.learning.mjs'), `import host from ${JSON.stringify(new URL('./autonomous-learning-host.mjs', import.meta.url).href)};\nexport default context => host(context, ${JSON.stringify(root)});\n`)
  console.log(JSON.stringify({ root, live: spec.live, command: `${process.execPath} ${fileURLToPath(import.meta.url)} --run ${root}` }))
} else if (args.includes('--run')) {
  const root = rootArg('--run'), spec = JSON.parse(await readFile(join(root, 'spec.json')))
  // Refuse silent retries and source edits after preparation.
  assert.equal((await readdir(root)).includes('runs.jsonl'), false, 'Use a new predeclared study; this run already has attempts.')
  for (const [path, digest] of Object.entries(spec.sourceHashes)) assert.equal(sha(await readFile(join(repo, path), 'utf8')), digest, `Prepared source changed: ${path}`)
  let error
  try {
    await command(root, ['add', '--trust', 'Learn the preview service behavior through self-selected experiments.'])
    const seed = await runCase(root, spec, spec.seed, 'baseline', '', undefined, undefined)
    await writeFile(join(root, 'seed.json'), JSON.stringify(seed, null, 2))
    console.error(JSON.stringify({ stage: 'cold', passed: seed.passed, settled: seed.usageComplete }))
    assert.ok(seed.usageComplete && seed.stopReason === 'end_turn' && !seed.passed, 'A settled cold gap is required.')
    await command(root, ['learn', join(root, 'experiment.learning.mjs'), '--trust'])
    const { report, agenda, state } = await inspect(root)
    if (report.cycle?.status === 'activated') {
      const accepted = state.learning.skills.find(s => s.name === 'preview-routing')
      assert.ok(accepted)
      for (const f of spec.holdout) await runCase(root, spec, f, 'reopened', accepted.body, undefined, undefined)
      await agenda.rollbackSkill(state, accepted.name, report.events.find(event => event.kind === 'started').data.agendaRevision, { key: `rollback-${report.cycle.cycleId}`, source: 'study-control', reason: 'Measure the effect of removing the accepted guidance.' })
      assert.equal((await agenda.read()).learning.skills.length, 0)
      for (const f of spec.holdout) await runCase(root, spec, f, 'rollback', '', undefined, undefined)
    }
  } catch (e) { error = String(e); process.exitCode = 1; await writeFile(join(root, 'error.txt'), error) }
  const { report } = await inspect(root)
  console.log(JSON.stringify({ root, status: report.cycle?.status, rounds: report.rounds, tokens: report.recordedTokens, unknownReceipts: report.unknownReceipts, error }))
} else if (args.includes('--inspect')) {
  const { report } = await inspect(rootArg('--inspect'))
  console.log(JSON.stringify({ root: report.root, status: report.cycle?.status, rounds: report.rounds, tokens: report.recordedTokens, unknownReceipts: report.unknownReceipts }))
} else { throw new Error('Use --prepare [--live], --run <prepared-root>, or --inspect <root>.') }
