import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as sdk from '../../packages/sdk/dist/index.js'
import { suite, episode, baselinePolicy } from './exploration-policy-environment.mjs'
import { evaluateEpisode, sha, skillName } from './exploration-policy-host.mjs'
import { model } from './tool-learning-host.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url)), cli = join(repo, 'packages/cli/dist/bin.js')
const args = process.argv.slice(2), arg = flag => args[args.indexOf(flag) + 1]
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const lines = async path => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse)
async function command(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--quiet', '--format', 'json', 'resident', ...args, '--cwd', join(root, 'workspace')], { cwd: join(root, 'workspace'), env: { ...process.env, NAMZU_HOME: join(root, 'home') }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      writeFile(join(root, `command-${args[0]}-${Date.now()}.json`), JSON.stringify({ args, code, stdout, stderr }, null, 2))
        .then(() => resolve({ code, stdout, stderr }), reject)
    })
  })
}
async function inspect(root) {
  const spec = await json(join(root, 'spec.json')), [projectId] = await readdir(join(root, 'home/residents'))
  const binding = await json(join(root, 'home/residents', projectId, 'default/binding.json'))
  const store = new sdk.SqliteResidentLearningStore({ databasePath: join(root, 'home/state/learning.sqlite'), artifactsPath: join(root, 'home/learning/artifacts'), scope: { ...binding, projectId }, readOnly: true })
  const agenda = new sdk.DiskResidentAgenda(join(root, 'home/residents', projectId), binding)
  const state = await agenda.read(), cycle = (await store.list())[0]
  const runs = await lines(join(root, 'runs.jsonl')), episodes = await lines(join(root, 'episodes.jsonl'))
  const report = { live: spec.live, spec, cycle, episodes, runs,
    events: cycle ? await store.events(cycle.cycleId, { limit: 256 }) : [],
    candidate: await json(join(root, 'candidate.json')).catch(() => null),
    active: state.learning?.skills ?? [],
    projection: { task: sdk.projectResidentLearning(state.learning, { maxChars: 8000, skillNames: [skillName] }), exploration: sdk.projectResidentLearning(state.learning, { maxChars: 8000, skillNames: [skillName], purpose: 'exploration' }) },
    rounds: Object.fromEntries(['verification', 'confirmation', 'holdout'].map(stage => [stage, Object.fromEntries(['baseline', 'candidate', 'reopened', 'rollback'].map(arm => {
      const rows = episodes.filter(r => r.episode.startsWith(stage) && r.arm === arm)
      return [arm, { passed: rows.filter(r => r.passed).length, count: rows.length, correct: rows.reduce((n,r) => n+r.correct,0), predictions: rows.reduce((n,r) => n+r.count,0), tokens: rows.reduce((n,r) => n+r.tokens,0), probes: rows.reduce((n,r) => n+r.probesUsed,0) }]
    }))])), tokens: runs.reduce((n,r) => n+r.tokens,0), unknownRuns: runs.filter(r => !r.usageComplete).map(r => r.runId) }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  return { report, agenda, state, store }
}
if (args.includes('--prepare')) {
  const root = await mkdtemp(join(tmpdir(), 'namzu-exploration-policy-')), seed = randomUUID(), live = args.includes('--live')
  assert.ok(!live || !args.includes('--control-provider-error'), 'Scripted provider faults cannot be enabled in a live study.')
  await mkdir(join(root, 'workspace')); await mkdir(join(root, 'home'))
  const priorPath = join(repo, 'research/resident/results/2026-09-14-autonomous-learning-muse.json'), prior = await json(priorPath)
  const training = { sourceRunId: prior.observations.evidence.key, sourceReportSha256: sha(await readFile(priorPath, 'utf8')),
    coldFailure: prior.events[0].data.failure, observations: prior.observations, explorerTokens: prior.runs.find(r => r.label === 'explore').tokens,
    result: { verification: prior.rounds.verification, confirmation: prior.rounds.confirmation } }
  const spec = { version: 1, live, seed, createdAt: Date.now(), model, effort: 'low', baselinePolicy,
    controlProviderError: args.includes('--control-provider-error'),
    limits: { records: 8, explorationIterations: 6, explorationTokens: 16000, predictionTokens: 12000, timeoutMs: 120000 },
    verification: suite(seed, 'verification'), confirmation: suite(seed, 'confirmation'),
    holdout: ['month', 'day', 'year'].map(f => episode(seed, 'holdout', f, 0)),
    protection: { verification: ['verification-identity', 'verification-kind'], confirmation: ['confirmation-identity', 'confirmation-kind'] },
    trainingSha256: sha(training), sourceHashes: {} }
  for (const name of ['exploration-policy-environment.mjs', 'exploration-policy-host.mjs', 'exploration-policy-study.mjs']) spec.sourceHashes[`research/resident/${name}`] = sha(await readFile(join(repo, 'research/resident', name), 'utf8'))
  for (const name of ['learning.js', 'learning-cycle.js']) spec.sourceHashes[`packages/sdk/dist/manager/resident/${name}`] = sha(await readFile(join(repo, 'packages/sdk/dist/manager/resident', name), 'utf8'))
  await writeFile(join(root, 'spec.json'), JSON.stringify(spec, null, 2)); await writeFile(join(root, 'training.json'), JSON.stringify(training, null, 2))
  await writeFile(join(root, 'home/preferences.json'), JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }))
  await writeFile(join(root, 'home/config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
  await writeFile(join(root, 'experiment.learning.mjs'), `import host from ${JSON.stringify(new URL('./exploration-policy-host.mjs', import.meta.url).href)};\nexport default context => host(context, ${JSON.stringify(root)});\n`)
  console.log(JSON.stringify({ root, live, command: `${process.execPath} ${fileURLToPath(import.meta.url)} --run ${root}` }))
} else if (args.includes('--run')) {
  const root = arg('--run'), spec = await json(join(root, 'spec.json'))
  assert.equal((await readdir(root)).includes('attempts.jsonl'), false, 'A study with attempts cannot be repeated.')
  for (const [path, digest] of Object.entries(spec.sourceHashes)) assert.equal(sha(await readFile(join(repo, path), 'utf8')), digest, `Prepared source changed: ${path}`)
  let error
  try {
    const added = await command(root, ['add', '--trust', 'Evaluate a proposed exploration policy using independent fresh environments.'])
    assert.equal(added.code, 0)
    await command(root, ['learn', join(root, 'experiment.learning.mjs'), '--trust'])
    const { report, agenda, state } = await inspect(root)
    if (report.cycle?.status === 'activated') {
      assert.deepEqual(report.projection.task.includedSkills, [])
      assert.deepEqual(report.projection.exploration.includedSkills, [skillName])
      // Reopen the agenda and use the explicitly selected exploration policy only.
      const projected = JSON.parse(report.projection.exploration.text)
      for (const e of spec.holdout) await evaluateEpisode(root, spec, e, 'reopened', projected.body)
      await agenda.rollbackSkill(state, skillName, report.events[0].data.agendaRevision, { key: `rollback-${report.cycle.cycleId}`, source: 'policy-study', reason: 'Check removing the accepted exploration policy.' })
      for (const e of spec.holdout) await evaluateEpisode(root, spec, e, 'rollback', baselinePolicy)
    }
  } catch (e) { error = String(e); process.exitCode = 1; await writeFile(join(root, 'error.txt'), error) }
  const { report } = await inspect(root)
  if (['cancelled', 'failed', 'inconclusive', 'activation-unknown'].includes(report.cycle?.status)) process.exitCode = 2
  console.log(JSON.stringify({ status: report.cycle?.status, rounds: report.rounds, tokens: report.tokens, unknownRuns: report.unknownRuns, error }))
} else if (args.includes('--inspect')) {
  const { report } = await inspect(arg('--inspect')); console.log(JSON.stringify({ status: report.cycle?.status, rounds: report.rounds, tokens: report.tokens }))
} else throw new Error('Use --prepare [--live], --run <root>, or --inspect <root>.')
