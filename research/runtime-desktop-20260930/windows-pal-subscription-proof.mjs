// Native Windows production SDK/CLI activity publication and actual local guests.
// Model inference/discovery alone is scripted. This fixture sends no external
// messages, uses no user account, and owns every home, guest and output below.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32')
const [snapshotArg, mode, homeArg, subscriptionId] = process.argv.slice(2)
assert.ok(snapshotArg)
const snapshot = realpathSync(resolve(snapshotArg))
assert.ok(basename(snapshot).startsWith('namzu-native-consumer-'))
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const moduleFile = (name, file) => {
  const item = manifest.packages.find((pkg) => pkg.name === name)
  assert.ok(item, `Built package exists: ${name}`)
  return join(snapshot, item.relative, file)
}
const sdk = await import(pathToFileURL(moduleFile('@namzu/sdk', 'dist/index.js')).href)
const loadCli = (file) => import(pathToFileURL(moduleFile('@namzu/cli', `dist/${file}.js`)).href)
const limits = (id) => ({
  subscriptionId: id, signal: new AbortController().signal,
  maxRecords: 5, maxReadBytes: 128 * 1024,
  causalityReadBytes: 1024 * 1024, causalityRecords: 4096,
})

if (mode === '--publish') {
  assert.ok(homeArg && subscriptionId)
  const home = realpathSync(resolve(homeArg))
  assert.ok(basename(home).startsWith('pal-subscriptions-'))
  process.env.NAMZU_HOME = home
  sdk.ProviderRegistry.create = () => { throw new Error('Finite publication cannot construct a model.') }
  globalThis.fetch = () => Promise.reject(new Error('Finite publication cannot make a network request.'))
  const activity = await loadCli('pals/activity')
  try {
    const result = await activity.publishCliPalActivity(limits(subscriptionId))
    process.stdout.write(JSON.stringify({ published: result }) + '\n')
  } catch (error) {
    // Only an explicit current-consent refusal is an expected fixture outcome.
    if (error?.name !== 'PalActivitySubscriptionDeniedError') throw error
    process.stdout.write(JSON.stringify({ refused: true, reason: error.message }) + '\n')
  }
} else {
  assert.equal(mode, undefined)
  assert.equal(homeArg, undefined)
  const home = join(snapshot, `pal-subscriptions-${randomUUID()}`)
  mkdirSync(home)
  process.env.NAMZU_HOME = home
  process.env.NAMZU_PAL_COMPUTER_ENGINE = 'podman'
  process.env.NAMZU_PAL_COMPUTER_IMAGE = 'namzu-local-computer:1'
  assert.ok(process.env.NAMZU_PAL_PODMAN_BINARY)
  assert.equal(process.env.NAMZU_PAL_PODMAN_MACHINE, 'podman-machine-default')
  assert.equal(process.env.NAMZU_PAL_PODMAN_CONNECTION, 'podman-machine-default-root')
  const cli = join(snapshot, manifest.cli)
  const runCli = (...args) => {
    const result = spawnSync(process.execPath, [cli, 'pal', ...args, '--json'], {
      env: process.env, encoding: 'utf8', windowsHide: true, shell: false,
    })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const source = runCli('create', 'Local activity source', '--model', 'ollama/activity-source')
  const recipient = runCli('create', 'Local activity recipient', '--model', 'ollama/activity-recipient')
  const sessions = await loadCli('integrations/sessions/store')
  const conversations = await loadCli('pals/conversations')
  const communication = await loadCli('pals/communication')
  const activity = await loadCli('pals/activity')
  const environment = await loadCli('pals/environment')
  const tui = await loadCli('tui/agent')
  const palTui = await loadCli('pals/tui-session')
  const providers = await loadCli('integrations/providers/index')
  const dispatch = await loadCli('pals/dispatch')
  const permissions = await loadCli('permissions/rules')
  const state = await sessions.openSessions(source.workspace)
  const origin = sdk.generateSessionId()
  await conversations.claimPalConversation(source.workspace, source.id, origin)
  const address = { tenantId: state.tenantId, palId: recipient.id }
  const inbox = communication.cliPalCommunicationStore()
  const subscriptions = communication.cliPalActivitySubscriptionStore()
  const policy = communication.cliPalActivitySubscriptionPolicy()
  const changeConsent = async (changes) => {
    const current = await policy.get(subscription.id)
    assert.ok(current)
    return policy.update({
      subscriptionId: current.subscriptionId, expectedRevision: current.revision,
      observe: current.observe, disclose: current.disclose,
      receive: current.receive, wake: current.wake, ...changes,
    })
  }
  const sourceLog = sdk.DiskSessionLog.at(state.paths, { sessionId: origin })
  const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
  const originalFetch = globalThis.fetch
  const originalCreate = sdk.ProviderRegistry.create
  const modelProviders = new Map()
  const checks = ['native CLI creates two private fixture Pals without external accounts']
  let agent
  let targetState
  let subscription
  const child = () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(import.meta.url), snapshot, '--publish', home, subscription.id,
    ], { env: process.env, encoding: 'utf8', windowsHide: true, shell: false })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.signal, null)
    return JSON.parse(result.stdout)
  }
  try {
    globalThis.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      if (url.hostname === 'localhost' && url.port === '11434' && url.pathname === '/api/tags')
        return Promise.resolve(new Response(JSON.stringify({ models: [
          { name: 'activity-source', model: 'activity-source' },
          { name: 'activity-recipient', model: 'activity-recipient' },
        ] }), { headers: { 'content-type': 'application/json' } }))
      if (url.protocol === 'data:' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
        return originalFetch(input, init)
      return Promise.reject(new Error('Native activity proof refuses non-fixture network requests.'))
    }
    const preferences = {
      version: 3, providers: [{ id: 'ollama', model: 'activity-source' }], subagents: { active: [] },
    }
    providers.writePreferences(preferences)
    await providers.ensureRegistered('ollama')
    sdk.ProviderRegistry.create = (config) => {
      assert.equal(config.type, 'ollama')
      const provider = modelProviders.get(config.model)
      assert.ok(provider, `Explicit fixture model exists: ${config.model}`)
      return { provider, capabilities: provider.capabilities }
    }
    const sourceProvider = new sdk.MockLLMProvider({ turns: [
      { toolCalls: [{ id: 'activity-fixture-source-write', name: 'write', args: {
        path: 'source-private.md', content: 'SOURCE_PRIVATE_GUEST_FILE Türkçe 🧪',
      } }] },
      { text: 'SOURCE_PRIVATE_MODEL_ANSWER: independent fixture work complete.' },
    ] })
    modelProviders.set('activity-source', sourceProvider)
    const rules = permissions.compilePermissions({
      write: 'allow', read: 'allow', bash: 'allow', computer_use: 'allow',
    }).rules
    agent = await tui.createAgentSession(preferences, [], {
      cwd: source.workspace, conversationSessions: state, permissionMode: 'auto', rules,
      scope: {
        sessionId: origin, tenantId: state.tenantId,
        projectId: state.projectId, topicId: state.topicId,
      },
      palEnvironment: await palTui.tuiPalEnvironment(source, origin),
    })
    for await (const event of agent.send([
      sdk.createUserMessage('SOURCE_PRIVATE_OPERATOR_PROMPT: perform only your independent private work.'),
    ], { limits: { maxIterations: 8 } })) {
      assert.notEqual(event.kind, 'error', JSON.stringify(event))
      if (event.kind === 'done' && event.stopReason) assert.equal(event.stopReason, 'end_turn')
    }
    const sourceLease = (await environment.getCliPalRuntime()).computer(source.id)
    assert.ok(sourceLease)
    assert.equal((await sourceLease.sandbox.readFile('/home/namzu/workspace/source-private.md')).toString(),
      'SOURCE_PRIVATE_GUEST_FILE Türkçe 🧪')
    const screen = await sourceLease.computerUseHost.execute({ type: 'screenshot' })
    assert.equal(screen.type, 'screenshot')
    writeFileSync(join(home, 'source-screen.png'), screen.result.data)
    await agent.close()
    agent = undefined
    await environment.closeCliPalRuntime()
    const original = await sourceLog.readAll()
    assert.equal(original.intact, true)
    assert.ok(original.entries.some(({ record }) => record.type === 'request_envelope' &&
      /^[a-f0-9]{16}$/.test(record.toolSchemaDigest)))
    assert.ok(original.entries.some(({ record }) => record.type === 'turn_completed'))
    checks.push('actual SDK query records independent source facts and real guest write/PNG; only model is scripted')
    subscription = await activity.subscribeCliPalActivity({
      sourcePalId: source.id, sourceSessionId: origin, recipientPalId: recipient.id,
      wake: true, signal: new AbortController().signal,
    })
    const sourceHash = digest(sourceLog.file)
    const profileFiles = [source, recipient].map((pal) => join(home, 'pals', pal.id, 'revisions', '1.json'))
    const profileHashes = profileFiles.map(digest)
    const accepted = []
    let complete = false
    let publications = 0
    // A finite original-record budget, never a wall-clock race.
    for (; publications < 64 && !complete; publications++) {
      const result = child()
      assert.ok(result.published, JSON.stringify(result))
      accepted.push(...result.published.accepted)
      complete = result.published.complete
      assert.equal(digest(sourceLog.file), sourceHash)
      assert.deepEqual(profileFiles.map(digest), profileHashes)
    }
    assert.equal(complete, true)
    assert.ok(publications > 1 && accepted.length > 0)
    assert.equal(new Set(accepted).size, accepted.length)
    const cursor = (await subscriptions.get(subscription.id)).cursor
    const replay = child()
    assert.deepEqual(replay.published.accepted, [])
    assert.deepEqual((await subscriptions.get(subscription.id)).cursor, cursor)
    let acceptedState = await inbox.readIngress(address)
    assert.equal(acceptedState.messages.length, accepted.length)
    assert.ok(acceptedState.messages.every((message) => message.kind === 'observation' && message.phase === 'pending'))
    assert.ok(acceptedState.messages.every((message) => message.subscriptionTrail.includes(subscription.id)))
    const privateSourceMarkers = [
      'SOURCE_PRIVATE_OPERATOR_PROMPT', 'SOURCE_PRIVATE_GUEST_FILE', 'SOURCE_PRIVATE_MODEL_ANSWER',
      'source-private.md',
    ]
    for (const marker of [...privateSourceMarkers, '/home/namzu/'])
      assert.equal(JSON.stringify(acceptedState.messages).includes(marker), false)
    checks.push('fresh native processes publish bounded pages, retain durable progress and dedup without modifying original journal/profile',
      'shared observation envelopes contain allowlisted facts and exact causality, excluding private source contents')
    const binding = acceptedState.routes[0]
    assert.ok(binding)
    targetState = await sessions.openSessions(recipient.workspace)
    const targetLog = sdk.DiskSessionLog.at(targetState.paths, { sessionId: binding.sessionId })
    assert.equal((await targetLog.readAll()).entries.length, 0)
    const reviewer = new sdk.MockLLMProvider({ turns: [
      { toolCalls: [{ id: 'activity-fixture-recipient-write', name: 'write', args: {
        path: 'observation-review.md', content: 'RECIPIENT_ACTUAL_GUEST_FILE Türkçe 🧪',
      } }] },
      { toolCalls: [{ id: 'activity-fixture-recipient-read', name: 'read', args: { path: 'observation-review.md' } }] },
      { toolCalls: [{ id: 'activity-fixture-recipient-shell', name: 'bash', args: { command: 'uname -s; pwd' } }] },
      { text: 'Local observed work reviewed.' },
    ] })
    const stream = reviewer.chatStream.bind(reviewer)
    let checkedReceipts = 0
    reviewer.chatStream = async function* (params) {
      // Before delegation to the fixture provider, verify every delivery visible
      // in this actual request against the shared ledger and original disk log.
      const current = await inbox.readIngress(address)
      const requestText = JSON.stringify(params.messages)
      for (const message of current.messages) {
        if (!requestText.includes(message.id)) continue
        assert.equal(message.phase, 'recorded')
        assert.ok(message.receipt)
        const read = await targetLog.readAll({ expectHead: message.receipt.through.pointer })
        assert.equal(read.intact, true)
        assert.ok(read.entries.some(({ record }) => record.type === 'message' &&
          record.messageId === message.receipt.messageId && record.content.source?.deliveryRef?.id === message.id &&
          record.content.source?.kind === 'host-observation'))
        checkedReceipts++
      }
      for (const marker of privateSourceMarkers) assert.equal(requestText.includes(marker), false)
      yield* stream(params)
    }
    modelProviders.set('activity-recipient', reviewer)
    const ctx = {
      config: { permissions: { write: 'allow', read: 'allow', bash: 'allow', computer_use: 'allow' }, limits: { maxIterations: 32 } },
      formatter: { print() {}, error() {} },
    }
    await changeConsent({ wake: false })
    assert.equal((await dispatch.dispatchCliPalMessages(ctx, recipient.id, new AbortController().signal)).status, 'blocked')
    assert.equal(reviewer.requests.length, 0)
    assert.ok((await inbox.readIngress(address)).messages.every((message) => message.phase === 'pending'))
    checks.push('current wake revocation blocks accepted pending observations with zero model requests')
    await changeConsent({ wake: true })
    // There may be several finite batches: each operation owns one bounded native run.
    for (let index = 0; index < accepted.length; index++) {
      acceptedState = await inbox.readIngress(address)
      if (acceptedState.messages.every((message) => message.phase === 'recorded')) break
      assert.equal((await dispatch.dispatchCliPalMessages(ctx, recipient.id, new AbortController().signal)).status, 'ran')
    }
    acceptedState = await inbox.readIngress(address)
    assert.ok(acceptedState.messages.every((message) => message.phase === 'recorded'))
    assert.ok(checkedReceipts > 0 && reviewer.requests.length > 0)
    const requestText = JSON.stringify(reviewer.requests)
    assert.ok(requestText.includes('RECIPIENT_ACTUAL_GUEST_FILE'))
    assert.ok(requestText.includes('Linux'))
    assert.ok(requestText.includes('host-observation'))
    assert.equal(digest(sourceLog.file), sourceHash)
    const runtime = await environment.getCliPalRuntime()
    const guest = await runtime.startComputer(recipient.id)
    assert.notEqual(guest.environmentId, sourceLease.environmentId)
    assert.equal((await guest.sandbox.readFile('/home/namzu/workspace/observation-review.md')).toString(),
      'RECIPIENT_ACTUAL_GUEST_FILE Türkçe 🧪')
    const targetScreen = await guest.computerUseHost.execute({ type: 'screenshot' })
    assert.equal(targetScreen.type, 'screenshot')
    writeFileSync(join(home, 'recipient-screen.png'), targetScreen.result.data)
    await environment.closeCliPalRuntime()
    checks.push('finite production dispatch records exact durable receipts before actual recipient SDK requests and guest tools',
      'recipient has a separate real local computer, guest file/Linux shell/PNG, without source private history')
    const progress = await subscriptions.get(subscription.id)
    await changeConsent({ observe: false })
    const denied = child()
    assert.equal(denied.refused, true)
    assert.deepEqual(await subscriptions.get(subscription.id), progress)
    assert.equal(digest(sourceLog.file), sourceHash)
    assert.deepEqual(profileFiles.map(digest), profileHashes)
    checks.push('a fresh publication process observes revocation and fails closed without changing progress or original source')
    const receipt = {
      passed: true, platform: process.platform, node: process.version, home,
      workingDirectory: process.cwd(),
      workingDirectoryKind: process.cwd().startsWith('\\\\') ? 'UNC' : 'native',
      productionSha256: Object.fromEntries([
        ['@namzu/sdk', 'dist/pals/activity/causality.js'],
        ['@namzu/sdk', 'dist/pals/activity/subscriptions.js'],
        ['@namzu/sdk', 'dist/pals/activity/subscription-policy.js'],
        ['@namzu/cli', 'dist/pals/activity.js'],
        ['@namzu/cli', 'dist/pals/dispatch.js'],
        ['@namzu/cli', 'dist/pals/agent-session.js'],
      ].map(([pkg, file]) => [`${pkg}/${file}`, digest(moduleFile(pkg, file))])),
      sourcePalId: source.id, recipientPalId: recipient.id, sourceSessionId: origin,
      subscriptionId: subscription.id, accepted: accepted.length, publicationProcesses: publications + 2,
      checkedReceipts, sourceSha256: sourceHash, checks,
      limitations: [
        'Already-built local consumer snapshot, not npm registry installation.',
        'Only model inference and catalogue discovery are scripted; no credentialed inference.',
        'Finite explicit publication/dispatch, not a daemon or external channel transport.',
      ],
    }
    writeFileSync(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
  } finally {
    const cleanupFailures = []
    for (const close of [
      () => agent?.close(), () => environment.closeCliPalRuntime(),
      () => targetState && sessions.closeSessions(targetState), () => sessions.closeSessions(state),
    ]) {
      try { await close() } catch (error) { cleanupFailures.push(error) }
    }
    sdk.ProviderRegistry.create = originalCreate
    globalThis.fetch = originalFetch
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'Own native fixture cleanup failed.')
  }
}
