// Explicit --live selects only Muse low. Default inference is scripted; tools and storage are real.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as sdk from '../../packages/sdk/dist/index.js'
import { executeCase, model } from './tool-learning-host.mjs'

const live = process.argv.includes('--live')
const root = await mkdtemp(join(tmpdir(), 'namzu-tool-learning-'))
const repo = fileURLToPath(new URL('../../', import.meta.url))
const home = join(root, 'home')
const signal = AbortSignal.timeout(900000)
const report = {
  root,
  live,
  model: live ? model : 'mock-model',
  effort: 'low',
  limits: {
    caseTokens: 18000,
    caseIterations: 8,
    caseTimeoutMs: 45000,
    cycleTokens: 800000,
    studyTimeoutMs: 900000,
  },
  startedAt: Date.now(),
  commands: [],
  holdout: [],
  controls: [],
}
await mkdir(home, { mode: 0o700 })
await writeFile(
  join(home, 'preferences.json'),
  JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }),
)
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
const sha = (body) => createHash('sha256').update(body).digest('hex')
const watched = [
  'packages/sdk/dist/agents/runAgent.js',
  'packages/sdk/dist/manager/resident/learning-store.js',
  'packages/sdk/dist/manager/resident/learning-cycle.js',
  'packages/cli/dist/commands/resident-learning.js',
  'packages/providers/zen/dist/client.js',
]
const fingerprint = async () =>
  Object.fromEntries(
    await Promise.all(watched.map(async (p) => [p, sha(await readFile(join(repo, p)))])),
  )
report.buildBefore = await fingerprint()
report.producerHashes = Object.fromEntries(
  await Promise.all(
    ['tool-learning-study.mjs', 'tool-learning-host.mjs'].map(async (p) => [
      p,
      sha(await readFile(new URL(p, import.meta.url))),
    ]),
  ),
)
const save = () => writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
async function fixture(id, family, trial, variant = 0) {
  const cwd = join(root, id === 'admission' ? 'workspace' : `cases/${id}`)
  const expected = `active-${id}-v${variant}`,
    stale = `retired-${id}`
  const source = `records/${sha(id + variant).slice(0, 9)}/settings.txt`
  for (const dir of ['docs', '.meta', source.slice(0, source.lastIndexOf('/'))])
    await mkdir(join(cwd, dir), { recursive: true })
  await writeFile(
    join(cwd, 'README.md'),
    '# Workspace\nSee docs/settings.txt for the release channel.\n',
  )
  await writeFile(join(cwd, 'docs/settings.txt'), `release_channel=${stale}\n`)
  await writeFile(
    join(cwd, '.meta/authority.json'),
    JSON.stringify({
      description: 'Current source selection; older documentation can be retained.',
      release_channel: { path: source, key: 'release_channel' },
    }),
  )
  const noise =
    family % 5 === 4
      ? Array.from({ length: 90 }, (_, i) => `unrelated_key_${i}=disabled`).join('\n') + '\n'
      : ''
  await writeFile(join(cwd, source), noise + `release_channel=${expected}\n`)
  // Varied read/search/recovery conditions; the correction teaches source selection, never an answer.
  if (family % 5 === 1)
    await writeFile(join(cwd, 'docs/settings.txt'), 'Moved: configuration/removed-settings.txt\n')
  if (family % 5 === 2)
    await writeFile(join(cwd, 'docs/settings.txt'), `Snapshot only; release_channel=${stale}\n`)
  if (family % 5 === 3)
    await writeFile(
      join(cwd, 'README.md'),
      '# Workspace\nSeveral copies of release_channel exist. Inspect source evidence.\n',
    )
  return {
    id,
    cwd,
    source,
    expected,
    stale,
    family: `${id.split('-')[0]}-${family}`,
    trial,
    prompt: 'What is the current release_channel for this workspace? Return only its value.',
  }
}
const seed = await fixture('seed', 0, 0)
const admission = await fixture('admission', 4, 0)
const suites = {}
for (const phase of ['verification', 'confirmation']) {
  suites[phase] = []
  for (let family = 0; family < 5; family++)
    for (let trial = 0; trial < 2; trial++)
      suites[phase].push(await fixture(`${phase}-${family}-${trial}`, family, trial))
}
const held = await Promise.all([0, 1, 2, 3].map((i) => fixture(`holdout-${i}`, i, 0, 1)))
const correction =
  'In this workspace family, .meta/authority.json is the authoritative current source map. Read it for every new workspace or question, then read the path selected for the requested key. README and docs can be stale snapshots or refer to moved files. If a documented path is missing, recover through the current map. Use narrow grep or a read window if the current source is long. Never reuse the seed answer or a source path from another workspace; a later source map update supersedes older guidance about a leaf path.'
await writeFile(
  join(root, 'study.json'),
  JSON.stringify({ seed, admission, ...suites, held, correction }, null, 2),
)
const modulePath = join(root, 'study.learning.mjs')
await writeFile(
  modulePath,
  `import createHost from ${JSON.stringify(new URL('./tool-learning-host.mjs', import.meta.url).href)};\nexport default host=>createHost(host,${JSON.stringify(root)},${live});\n`,
)
const run = promisify(execFile)
const command = async (args, allowOutcome = false) => {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        join(repo, 'packages/cli/dist/bin.js'),
        '--quiet',
        '--format',
        'json',
        'resident',
        ...args,
        '--cwd',
        admission.cwd,
      ],
      {
        cwd: admission.cwd,
        env: { ...process.env, NAMZU_HOME: home },
        signal,
        timeout: 700000,
        maxBuffer: 2 * 1024 * 1024,
      },
    )
    // Progress goes to stderr; stdout holds the complete CLI JSON object.
    const value = JSON.parse(stdout)
    report.commands.push({ args, exit: 0, stdout, stderr })
    await save()
    return value
  } catch (error) {
    report.commands.push({ args, exit: error.code, stdout: error.stdout, stderr: error.stderr })
    await save()
    if (allowOutcome && error.stdout?.trim()) return JSON.parse(error.stdout)
    throw error
  }
}
try {
  console.log(JSON.stringify({ root, live, model: report.model }))
  await command([
    'add',
    '--trust',
    'Determine the current release_channel using the current workspace sources. Complete with only the exact value as the summary. Do not modify files or run commands.',
  ])
  const cold = await executeCase(root, seed, '', 'cold', live, signal, undefined, undefined, false)
  await writeFile(join(root, 'seed.json'), JSON.stringify(cold, null, 2))
  report.cold = cold
  if (cold.output?.trim() === seed.expected)
    throw new Error('No seed failure observed; do not fabricate one or spend a learning cycle.')
  const learning = await command(['learn', modulePath, '--trust'], true)
  report.learning = learning
  const [project] = await readdir(join(home, 'residents'))
  const binding = JSON.parse(
    await readFile(join(home, 'residents', project, 'default', 'binding.json')),
  )
  const agenda = new sdk.DiskResidentAgenda(join(home, 'residents', project), binding)
  const store = new sdk.SqliteResidentLearningStore({
    databasePath: join(home, 'state/learning.sqlite'),
    artifactsPath: join(home, 'learning/artifacts'),
    scope: { ...binding, projectId: project },
    readOnly: true,
  })
  const cycle = (await store.list())[0]
  report.cycle = cycle
  const active = (await agenda.read()).learning?.skills[0]
  report.outcome = cycle.status
  const candidate = cycle.result?.candidate
  assert.ok(candidate, 'No candidate returned; no synthetic replacement.')
  const measuredGuidance = active?.body ?? candidate.body
  report.measurementUsesActiveSkill = Boolean(active)
  for (const fixture of held)
    for (const arm of ['frozen', 'memory', 'guidance']) {
      const guidance =
        arm === 'memory'
          ? JSON.stringify({ seed: cold, correction })
          : arm === 'guidance'
            ? measuredGuidance
            : ''
      const r = await executeCase(
        root,
        fixture,
        guidance,
        `holdout/${arm}/${fixture.id}`,
        live,
        signal,
        undefined,
        undefined,
        arm !== 'frozen',
      )
      report.holdout.push({
        arm,
        id: fixture.id,
        expected: fixture.expected,
        output: r.output,
        correct: r.output?.trim() === fixture.expected,
        runId: r.runId,
      })
    }
  // The current map changes after learning; a stale leaf path must not survive that update.
  const previous = await fixture('updated-map', 2, 0, 1)
  const updated = await fixture('updated-map', 2, 0, 2)
  report.mapUpdate = {
    oldSource: previous.source,
    newSource: updated.source,
    oldValue: previous.expected,
    newValue: updated.expected,
  }
  const unrelated = 'When writing release notes, use short headings and plain language.'
  for (const [arm, guidance] of [
    ['current', measuredGuidance],
    ['irrelevant', unrelated],
    ['stale', 'Use docs/settings.txt directly; it always contains the current value.'],
  ]) {
    const r = await executeCase(
      root,
      updated,
      guidance,
      `control/${arm}`,
      live,
      signal,
      undefined,
      undefined,
      arm === 'current',
    )
    report.controls.push({
      arm,
      expected: updated.expected,
      output: r.output,
      correct: r.output?.trim() === updated.expected,
      runId: r.runId,
    })
  }
  if (live && active) {
    report.cliAdmission = await command([
      'run',
      '--trust',
      '--max-steps',
      '1',
      '--max-iterations',
      '6',
      '--token-budget',
      '18000',
      '--provider',
      'zen',
      '--model',
      model,
      '--effort',
      'low',
    ])
    report.cliStatus = await command(['status'])
    report.cliInspection = await command(['inspect'])
    const pursuit = report.cliStatus.agenda.pursuits[0]
    report.cliObserved = {
      phase: pursuit.state.phase,
      summary: pursuit.state.summary,
      expected: admission.expected,
    }
    assert.equal(pursuit.state.phase, 'complete')
    assert.equal(pursuit.state.summary.trim(), admission.expected)
  }
  report.inspection = await command(['learning', cycle.cycleId, '--events', '--limit', '4'])
  const current = await agenda.read()
  if (active)
    await agenda.rollbackSkill(current, active.name, 1, {
      key: randomUUID(),
      source: 'tool-learning-study',
      reason: 'Explicit rollback after independently checked observations.',
    })
  report.rollback = {
    performed: Boolean(active),
    activeSkills: (await agenda.read()).learning?.skills ?? [],
  }
  assert.equal(report.rollback.activeSkills.length, 0)
  if (active)
    report.rollback.observation = await executeCase(
      root,
      held[0],
      '',
      'after-rollback',
      live,
      signal,
    )
  report.artifacts = await store.artifacts(cycle.cycleId)
  report.buildAfter = await fingerprint()
  assert.deepEqual(report.buildAfter, report.buildBefore)
  report.completed = true
} catch (error) {
  report.error = String(error)
  report.completed = false
  process.exitCode = 1
} finally {
  report.finishedAt = Date.now()
  const lines = await readFile(join(root, 'runs.jsonl'), 'utf8').catch(() => '')
  report.runs = lines.trim() ? lines.trim().split('\n').map(JSON.parse) : []
  report.recordedSdkTokens = report.runs.reduce((n, r) => n + r.tokens, 0)
  report.cliTokens = report.cliInspection?.inspection?.recorded?.ownTokens ?? 0
  report.totalRecordedTokens = report.recordedSdkTokens + report.cliTokens
  report.incompleteRuns = report.runs.filter((r) => r.stopReason !== 'end_turn').length
  report.unpricedSdkTokens = report.runs.reduce(
    (n, r) => n + (r.cost?.unpricedTokens ?? r.tokens),
    0,
  )
  await save()
  console.log(
    JSON.stringify({
      root,
      completed: report.completed,
      error: report.error,
      runs: report.runs.length,
      tokens: report.recordedSdkTokens,
    }),
  )
}
