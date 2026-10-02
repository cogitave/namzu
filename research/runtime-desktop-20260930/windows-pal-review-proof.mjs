// Native Windows production CLI/SDK/guest proof. Only inference is scripted.
// Each phase runs in a fresh process with the same private, immutable Pal route.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32')
const [snapshot, phase, savedHome] = process.argv.slice(2)
assert.ok(snapshot && basename(snapshot).startsWith('namzu-native-consumer-') && basename(snapshot).includes('appearance'))
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const moduleFile = (name, file) => {
  const pkg = manifest.packages.find((item) => item.name === name)
  assert.ok(pkg, name)
  return join(snapshot, pkg.relative, file)
}
const sdkFile = moduleFile('@namzu/sdk', 'dist/index.js')
const cliFile = (file) => moduleFile('@namzu/cli', `dist/${file}.js`)
const loadCli = (file) => import(pathToFileURL(cliFile(file)).href)
const cli = join(snapshot, manifest.cli)
const home = savedHome ?? join(snapshot, `pal-review-${randomUUID()}`)
assert.ok(home.startsWith(snapshot) && basename(home).startsWith('pal-review-'))

const runtimeTreeHash = (name) => {
  const directory = moduleFile(name, 'dist')
  const hash = createHash('sha256')
  let files = 0
  const visit = (relative = '') => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      assert.equal(entry.isSymbolicLink(), false, 'Proof runtime tree must contain regular copied files.')
      if (entry.isDirectory()) visit(path)
      else {
        assert.equal(entry.isFile(), true)
        hash.update(path).update('\0').update(createHash('sha256').update(readFileSync(join(directory, path))).digest()).update('\0')
        files += 1
      }
    }
  }
  visit()
  return { package: name, files, sha256: hash.digest('hex') }
}

if (!phase) {
  assert.equal(existsSync(home), false)
  mkdirSync(home)
  const checks = []
  for (const name of ['park', 'resume', 'verify']) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), snapshot, name, home], {
      env: { ...process.env, NAMZU_HOME: home }, encoding: 'utf8', windowsHide: true,
      shell: false, maxBuffer: 2_000_000,
    })
    assert.equal(result.status, 0, `${name}: ${result.stderr}`)
    assert.equal(result.signal, null)
    checks.push(...JSON.parse(readFileSync(join(home, `${name}-receipt.json`), 'utf8')).checks)
  }
  const files = [
    sdkFile, cliFile('pals/agent-session'), cliFile('pals/actions'), cliFile('pals/review'),
    moduleFile('@namzu/sdk', 'dist/runtime/query/resume-session.js'),
    moduleFile('@namzu/sdk', 'dist/runtime/query/checkpoint.js'),
    moduleFile('@namzu/sandbox', 'dist/local-virtual-computer/index.js'),
  ]
  const sourceHashes = files.map((file) => ({
    file: file.slice(snapshot.length + 1).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
  }))
  sourceHashes.push({
    file: 'research/runtime-desktop-20260930/windows-pal-review-proof.mjs',
    sha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
  })
  const receipt = {
    passed: true, platform: process.platform, node: process.version,
    callerWorkingDirectoryKind: process.cwd().startsWith('\\\\wsl.') ? 'WSL UNC' : 'native Windows',
    phases: 3, checks, sourceHashes,
    runtimeTreeHashes: ['@namzu/sdk', '@namzu/cli', '@namzu/sandbox'].map(runtimeTreeHash),
    limitations: [
      'Built consumer snapshot, not a registry install. No dependency or engine installation.',
      'Model inference is scripted; CLI session, SDK journal/checkpoint/replay and local guest are production code.',
      'Authenticated actor/current consent is an explicit private host fixture, not an external channel account.',
      'Resolution receipts prove the answer was applied, not success of arbitrary future tools.',
      'Podman Linux container guest is not a full VM; Chromium browser sandbox and cgroup quotas remain disabled as documented.',
    ],
  }
  writeFileSync(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2))
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
} else {
  assert.ok(['park', 'resume', 'verify'].includes(phase) && existsSync(home))
  process.env.NAMZU_HOME = home
  process.env.NAMZU_PAL_COMPUTER_ENGINE = 'podman'
  process.env.NAMZU_MODEL_CATALOGUE_REFRESH = '0'
  assert.ok(process.env.NAMZU_PAL_PODMAN_BINARY && process.env.NAMZU_PAL_PODMAN_MACHINE && process.env.NAMZU_PAL_PODMAN_CONNECTION)
  const sdk = await import(pathToFileURL(sdkFile).href)
  const sessions = await loadCli('integrations/sessions/store')
  const conversations = await loadCli('pals/conversations')
  const environment = await loadCli('pals/environment')
  const palTui = await loadCli('pals/tui-session')
  const tui = await loadCli('tui/agent')
  const providers = await loadCli('integrations/providers/index')
  const actions = await loadCli('pals/actions')
  const review = await loadCli('pals/review')
  const runCli = (...args) => {
    const result = spawnSync(process.execPath, [cli, 'pal', ...args, '--json'], {
      env: process.env, encoding: 'utf8', windowsHide: true, shell: false,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const saved = phase === 'park' ? undefined : JSON.parse(readFileSync(join(home, 'waiting.json'), 'utf8'))
  const profile = saved?.profile ?? runCli('create', 'Native parked reviewer', '--purpose', 'PINNED_NATIVE_REVIEW_PURPOSE', '--model', 'ollama/native-parked')
  const sessionId = saved?.scope.sessionId ?? sdk.generateSessionId()
  if (phase === 'park') await conversations.claimPalConversation(profile.workspace, profile.id, sessionId)
  const state = await sessions.openSessions(profile.workspace)
  const scope = { sessionId, tenantId: state.tenantId, projectId: state.projectId, topicId: state.topicId }
  if (saved) assert.deepEqual(scope, saved.scope)
  const preferences = { version: 3, providers: [{ id: 'ollama', model: 'native-parked' }], subagents: { active: [] } }
  const script = phase === 'park'
    ? [{ toolCalls: [{ id: 'native-first-reviewed-call', name: 'bash', args: { command: 'printf x >> approval-count.txt' } }] }]
    : phase === 'resume'
      ? [{ toolCalls: [{ id: 'native-next-reviewed-call', name: 'bash', args: { command: 'printf y >> later-count.txt' } }] }]
      : [{ text: 'The two separately approved guest operations completed.' }]
  const model = new sdk.MockLLMProvider({ turns: script })
  const originalCreate = sdk.ProviderRegistry.create
  const originalFetch = globalThis.fetch
  let agent
  const checks = []
  const log = sdk.DiskSessionLog.at(state.paths, { sessionId })
  const currentConsent = { allowed: true }
  const hostPolicy = { mode: phase === 'resume' ? 'auto' : phase === 'verify' ? 'accept-edits' : 'prompt' }
  const consent = async (actor, ref, signal) => {
    signal.throwIfAborted()
    assert.equal(actor.tenantId, scope.tenantId)
    assert.equal(actor.actorId, 'private-authenticated-operator')
    assert.equal(actor.connectionId, 'private-verified-connection')
    assert.equal(ref.sessionId, scope.sessionId)
    if (!currentConsent.allowed) throw new Error('Current native host consent revoked.')
  }
  const actor = { tenantId: scope.tenantId, actorId: 'private-authenticated-operator', connectionId: 'private-verified-connection' }
  const waitingRef = async (pending) => {
    const waiting = await review.readPalWaitingReview(log, pending.turnId, pending.checkpointId)
    assert.ok(waiting)
    return { sessionId, turnId: waiting.turnId, checkpointId: waiting.checkpointId,
      decisionId: waiting.decisionId, requestKind: 'tool_review', requestRecord: waiting.requestRecord,
      checkpointDocSha256: waiting.checkpointDocSha256 }
  }
  try {
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.hostname === 'localhost' && url.port === '11434' && url.pathname === '/api/tags')
        return Promise.resolve(new Response(JSON.stringify({ models: [{ name: 'native-parked', model: 'native-parked' }] }), { headers: { 'content-type': 'application/json' } }))
      if (url.protocol === 'data:' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') return originalFetch(input, init)
      return Promise.reject(new Error('Native review proof refuses non-fixture network access.'))
    }
    providers.writePreferences(preferences)
    await providers.ensureRegistered('ollama')
    sdk.ProviderRegistry.create = (config) => {
      assert.equal(config.type, 'ollama')
      assert.equal(config.model, 'native-parked')
      return { provider: model, capabilities: model.capabilities }
    }
    const binding = await palTui.tuiPalDefinition(profile.workspace, sessionId, profile.id)
    assert.equal(binding.revision, 1)
    agent = await tui.createAgentSession(preferences, [], {
      cwd: profile.workspace, scope, conversationSessions: state, permissionMode: hostPolicy.mode,
      palEnvironment: await palTui.tuiPalEnvironment(binding, sessionId),
    })
    const runtime = await environment.getCliPalRuntime()
    const guest = runtime.computer(profile.id)
    assert.ok(guest)
    const count = async (name) => {
      const result = await guest.sandbox.exec('sh', ['-c', `if test -f ${name}; then cat ${name}; else printf absent; fi`])
      assert.equal(result.exitCode, 0)
      return result.stdout
    }
    const gate = () => actions.createCliPalReviewActions({ profile: binding, scope, paths: state.paths, session: agent, authorize: consent, currentPermissionMode: () => hostPolicy.mode })
    if (phase === 'park') {
      for await (const event of agent.send([sdk.createUserMessage('Wait for one-batch approval before changing the guest.')], {
        permissionMode: 'prompt', reviewHold: { reason: 'An authenticated operator must answer this batch.' },
        limits: { tokenBudget: 0, maxIterations: 6, timeoutMs: 0 },
      })) assert.notEqual(event.kind, 'error', JSON.stringify(event))
      assert.equal(model.requests.length, 1)
      assert.equal(await count('approval-count.txt'), 'absent')
      const pending = await sdk.findPendingCheckpoint(log)
      assert.ok(pending)
      const first = { actor, operationId: 'verified-native-review-1', waiting: await waitingRef(pending), answer: { action: 'approve_once' } }
      writeFileSync(join(home, 'waiting.json'), JSON.stringify({ profile, scope, first }, null, 2))
      runCli('update', profile.id, '--revision', '1', '--purpose', 'CHANGED_NATIVE_PROFILE_PURPOSE', '--model', 'ollama/changed-native-profile')
      checks.push('fresh native CLI creates a private Pal and real SDK checkpoint park; model-requested guest change has no effect before approval')
      checks.push('new profile revision changes purpose/model while the original conversation remains pinned to revision 1')
    } else if (phase === 'resume') {
      assert.equal(await count('approval-count.txt'), 'absent')
      const receipt = await gate().execute(saved.first)
      assert.equal(receipt.status, 'resolved')
      assert.ok(receipt.resolutionRecord.seq > receipt.requestRecord.seq)
      assert.equal(await count('approval-count.txt'), 'x')
      assert.equal(await count('later-count.txt'), 'absent')
      assert.equal(model.requests.length, 1)
      assert.ok(JSON.stringify(model.requests[0]).includes('PINNED_NATIVE_REVIEW_PURPOSE'))
      assert.ok(!JSON.stringify(model.requests[0]).includes('CHANGED_NATIVE_PROFILE_PURPOSE'))
      const pending = await sdk.findPendingCheckpoint(log)
      assert.equal(pending.turnId, saved.first.waiting.turnId)
      assert.notEqual(pending.checkpointId, saved.first.waiting.checkpointId)
      const second = { actor, operationId: 'verified-native-review-2', waiting: await waitingRef(pending), answer: { action: 'approve_once' } }
      writeFileSync(join(home, 'waiting.json'), JSON.stringify({ ...saved, firstReceipt: receipt, second }, null, 2))
      checks.push('second native process restores the exact original turn and approved guest batch once under pinned model/purpose and original recorded limits')
      checks.push('real native decision resolution pointer acknowledges the first answer; a later guest batch receives a distinct durable checkpoint and remains unexecuted')
      checks.push('host auto mode supplies no later automatic approval through the authenticated one-batch action')
    } else {
      assert.equal(await count('approval-count.txt'), 'x')
      assert.equal(await count('later-count.txt'), 'absent')
      assert.deepEqual(await gate().execute(saved.first), saved.firstReceipt)
      assert.equal(model.requests.length, 0)
      await assert.rejects(gate().execute({ ...saved.first, answer: { action: 'reject', feedback: 'changed retry' } }), /Conflicting retry/)
      await assert.rejects(gate().execute({ ...saved.second, waiting: { ...saved.second.waiting, requestRecord: { ...saved.second.waiting.requestRecord, sha256: 'a'.repeat(64) } } }), /actual waiting/)
      currentConsent.allowed = false
      await assert.rejects(gate().execute(saved.second), /revoked/)
      currentConsent.allowed = true
      assert.equal(model.requests.length, 0)
      const secondReceipt = await gate().execute(saved.second)
      assert.equal(secondReceipt.status, 'resolved')
      assert.equal(await count('approval-count.txt'), 'x')
      assert.equal(await count('later-count.txt'), 'y')
      const records = (await log.readAll({ mode: 'strict' })).entries.map(({ record }) => record)
      assert.equal(records.filter((record) => record.type === 'turn_started').length, 1)
      assert.deepEqual({ tokenBudget: records.find((record) => record.type === 'turn_started').config.tokenBudget,
        maxIterations: records.find((record) => record.type === 'turn_started').config.maxIterations,
        timeoutMs: records.find((record) => record.type === 'turn_started').config.timeoutMs },
      { tokenBudget: 0, maxIterations: 6, timeoutMs: 0 })
      assert.equal(records.filter((record) => record.type === 'decision_resolved').length, 2)
      assert.equal(records.filter((record) => record.type === 'tool_completed' && record.toolUseId === 'native-first-reviewed-call').length, 1)
      assert.equal(records.filter((record) => record.type === 'tool_completed' && record.toolUseId === 'native-next-reviewed-call').length, 1)
      assert.equal((await log.activeTurn()), null)
      const screen = await guest.computerUseHost.execute({ type: 'screenshot' })
      assert.equal(screen.type, 'screenshot')
      writeFileSync(join(home, 'review-guest.png'), screen.result.data)
      checks.push('third native process keeps the guest volume and duplicate action returns original durable receipt without inference or repeated effects')
      checks.push('changed retry, forged request pointer and current consent revocation refuse before another model request or guest change')
      checks.push('separate second approval completes the same turn; two exact tool IDs execute once each and the real guest yields a PNG')
      checks.push('fresh host accept-edits mode retains duplicate refusal and separately applies the exact later decision')
    }
  } finally {
    await agent?.close()
    await environment.closeCliPalRuntime()
    sessions.closeSessions(state)
    sdk.ProviderRegistry.create = originalCreate
    globalThis.fetch = originalFetch
  }
  checks.push(`${phase}: owned native Pal session and actual local computer confirm shutdown`)
  writeFileSync(join(home, `${phase}-receipt.json`), JSON.stringify({ passed: true, checks }, null, 2))
}
