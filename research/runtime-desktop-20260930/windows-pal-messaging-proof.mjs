// Native Windows proof over built production CLI, SDK logs and real Pal guests.
// Only model inference/discovery is scripted. All homes, guests and artifacts
// belong to this fixture; no external messages or user windows are accessed.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32')
const [snapshot] = process.argv.slice(2)
assert.ok(snapshot && basename(snapshot).startsWith('namzu-native-consumer-'))
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const moduleFile = (name, file) => {
  const pkg = manifest.packages.find((item) => item.name === name)
  assert.ok(pkg)
  return join(snapshot, pkg.relative, file)
}
const sdk = await import(pathToFileURL(moduleFile('@namzu/sdk', 'dist/index.js')).href)
const loadCli = (file) => import(pathToFileURL(moduleFile('@namzu/cli', `dist/${file}.js`)).href)
const home = join(snapshot, `pal-messaging-${randomUUID()}`)
mkdirSync(home)
process.env.NAMZU_HOME = home
process.env.NAMZU_PAL_COMPUTER_ENGINE = 'podman'
assert.ok(process.env.NAMZU_PAL_PODMAN_BINARY)
const cli = join(snapshot, manifest.cli)
const runCli = (...args) => {
  const result = spawnSync(process.execPath, [cli, 'pal', ...args, '--json'], {
    env: process.env, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}
const one = runCli('create', 'Local researcher', '--model', 'ollama/native-sender')
const two = runCli('create', 'Local reviewer', '--model', 'ollama/native-recipient')
runCli('grant', one.id, two.id, '--wake')
runCli('grant', two.id, one.id, '--wake')
const checks = ['native CLI creates two private Pals and persists two directed wake grants']
const sessions = await loadCli('integrations/sessions/store')
const conversations = await loadCli('pals/conversations')
const communication = await loadCli('pals/communication')
const environment = await loadCli('pals/environment')
const tui = await loadCli('tui/agent')
const palTui = await loadCli('pals/tui-session')
const providers = await loadCli('integrations/providers/index')
const dispatch = await loadCli('pals/dispatch')
const permissions = await loadCli('permissions/rules')
const state = await sessions.openSessions(one.workspace)
const origin = sdk.generateSessionId()
await conversations.claimPalConversation(one.workspace, one.id, origin)
const address = (pal) => ({ tenantId: state.tenantId, palId: pal.id })
const inbox = communication.cliPalCommunicationStore()
const policy = communication.cliPalCommunicationPolicy()
const originalFetch = globalThis.fetch
const originalCreate = sdk.ProviderRegistry.create
const modelProviders = new Map()
let agent
let originalRuntime
try {
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.hostname === 'localhost' && url.port === '11434' && url.pathname === '/api/tags')
      return Promise.resolve(new Response(JSON.stringify({ models: [
        { name: 'native-sender', model: 'native-sender' },
        { name: 'native-recipient', model: 'native-recipient' },
      ] }), { headers: { 'content-type': 'application/json' } }))
    if (url.protocol === 'data:' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      return originalFetch(input, init)
    return Promise.reject(new Error('Native Pal proof refuses non-fixture network requests.'))
  }
  const preferences = { version: 3, providers: [{ id: 'ollama', model: 'native-sender' }], subagents: { active: [] } }
  providers.writePreferences(preferences)
  await providers.ensureRegistered('ollama')
  // Explicit test instrumentation. No guest, policy, inbox, receipt, query or
  // agent implementation is replaced.
  sdk.ProviderRegistry.create = (config) => {
    assert.equal(config.type, 'ollama')
    const provider = modelProviders.get(config.model)
    assert.ok(provider, `Fixture model exists: ${config.model}`)
    return { provider, capabilities: provider.capabilities }
  }
  const body = 'EXPLICIT_NATIVE_PAL_FINDING Türkçe 🧪'
  const sender = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'native-fixture-call-1', name: 'write', args: { path: 'sender-private.md', content: 'SENDER_PRIVATE_GUEST_FILE' } }] },
    { toolCalls: [{ id: 'native-fixture-call-2', name: 'list_pals', args: {} }] },
    { toolCalls: [{ id: 'native-fixture-call-3', name: 'send_pal_message', args: { palId: two.id, body } }] },
    { text: 'Finding sent.' },
  ] })
  modelProviders.set('native-sender', sender)
  const rules = permissions.compilePermissions({ write: 'allow', read: 'allow', bash: 'allow', computer_use: 'allow', send_pal_message: 'allow' }).rules
  const scope = { sessionId: origin, tenantId: state.tenantId, projectId: state.projectId, topicId: state.topicId }
  agent = await tui.createAgentSession(preferences, [], {
    cwd: one.workspace, scope, conversationSessions: state, permissionMode: 'auto', rules,
    palEnvironment: await palTui.tuiPalEnvironment(one, origin),
  })
  originalRuntime = await environment.getCliPalRuntime()
  const initialEvents = []
  for await (const event of agent.send([sdk.createUserMessage('SENDER_PRIVATE_OPERATOR_PROMPT: send only the explicit finding.')], { limits: { maxIterations: 8 } })) {
    initialEvents.push(event)
    assert.notEqual(event.kind, 'error', JSON.stringify(event))
  }
  await agent.close()
  agent = undefined
  const accepted = (await inbox.read(address(two))).messages[0]
  assert.equal(accepted.body, body)
  assert.equal(accepted.phase, 'pending')
  assert.ok(JSON.stringify(sender.requests).includes(two.id))
  const targetBinding = (await inbox.read(address(two))).routes.find((route) => route.id === accepted.routeId)
  const targetState = await sessions.openSessions(two.workspace)
  try {
    assert.equal((await sdk.DiskSessionLog.at(targetState.paths, { sessionId: targetBinding.sessionId }).readAll()).entries.length, 0)
  } finally { sessions.closeSessions(targetState) }
  checks.push('actual Pal query ToolExecutor sends one pending durable message without starting recipient inference')
  const reviewer = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'native-fixture-call-4', name: 'write', args: { path: 'review.md', content: 'REVIEWER_LOCAL_FILE Türkçe 🧪' } }] },
    { toolCalls: [{ id: 'native-fixture-call-5', name: 'read', args: { path: 'review.md' } }] },
    { toolCalls: [{ id: 'native-fixture-call-6', name: 'bash', args: { command: 'uname -s; pwd' } }] },
    { toolCalls: [{ id: 'native-fixture-call-7', name: 'computer_use', args: { type: 'screenshot' } }] },
    { toolCalls: [{ id: 'native-fixture-call-8', name: 'send_pal_message', args: { palId: one.id, body: 'EXPLICIT_NATIVE_PAL_REPLY', replyTo: accepted.id } }] },
    { text: 'Review completed.' },
  ] })
  modelProviders.set('native-recipient', reviewer)
  const ctx = { config: { permissions: { write: 'allow', read: 'allow', bash: 'allow', computer_use: 'allow', send_pal_message: 'allow' }, limits: { maxIterations: 10 } }, formatter: { print() {}, error() {} } }
  const outcome = await dispatch.dispatchCliPalMessages(ctx, two.id, new AbortController().signal)
  assert.equal(outcome.status, 'ran')
  const delivered = (await inbox.read(address(two))).messages.find((message) => message.id === accepted.id)
  assert.equal(delivered.phase, 'recorded')
  assert.ok(JSON.stringify(reviewer.requests).includes(body))
  assert.ok(JSON.stringify(reviewer.requests).includes('REVIEWER_LOCAL_FILE'))
  assert.ok(JSON.stringify(reviewer.requests).includes('Linux'))
  assert.ok(JSON.stringify(reviewer.requests).includes('image/png'))
  assert.ok(!JSON.stringify(reviewer.requests).includes('SENDER_PRIVATE_OPERATOR_PROMPT'))
  assert.ok(!JSON.stringify(reviewer.requests).includes('SENDER_PRIVATE_GUEST_FILE'))
  const receiverLog = await communication.createCliPalMessageHost().openConversation(outcome.binding, new AbortController().signal)
  const durableRead = await receiverLog.log.readAll({ expectHead: delivered.receipt.through.pointer })
  assert.ok(durableRead.entries.some(({ record }) => record.type === 'message' && record.messageId === delivered.receipt.messageId && record.content.source?.deliveryRef?.id === accepted.id))
  const replyState = await inbox.read(address(one))
  const reply = replyState.messages[0]
  assert.equal(reply.body, 'EXPLICIT_NATIVE_PAL_REPLY')
  assert.equal(reply.replyTo, accepted.id)
  const replyBinding = replyState.routes.find((route) => route.id === reply.routeId)
  assert.equal(replyBinding.sessionId, origin)
  checks.push('finite production CLI dispatch records exact SDK receipt before scripted recipient sees input', 'recipient query uses actual guest files/Linux shell/PNG and cannot see sender private history', 'replyTo routes explicit reply to the original sender conversation')
  const resumedSender = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'native-fixture-call-9', name: 'read', args: { path: 'sender-private.md' } }] },
    { text: 'Explicit reply received in original conversation.' },
  ] })
  modelProviders.set('native-sender', resumedSender)
  assert.equal((await dispatch.dispatchCliPalMessages(ctx, one.id, new AbortController().signal)).status, 'ran')
  assert.ok(JSON.stringify(resumedSender.requests).includes('EXPLICIT_NATIVE_PAL_REPLY'))
  assert.ok(JSON.stringify(resumedSender.requests).includes('SENDER_PRIVATE_GUEST_FILE'))
  assert.equal((await inbox.read(address(one))).messages[0].phase, 'recorded')
  checks.push('original conversation receives durable reply and retains its own guest file after computer restart')
  const restarted = await environment.getCliPalRuntime()
  const guestOne = await restarted.startComputer(one.id)
  const guestTwo = await restarted.startComputer(two.id)
  assert.notEqual(guestOne.environmentId, guestTwo.environmentId)
  assert.equal((await guestTwo.sandbox.readFile('/home/namzu/workspace/review.md')).toString(), 'REVIEWER_LOCAL_FILE Türkçe 🧪')
  for (const [label, guest] of [['sender', guestOne], ['recipient', guestTwo]]) {
    const screen = await guest.computerUseHost.execute({ type: 'screenshot' })
    assert.equal(screen.type, 'screenshot')
    writeFileSync(join(home, `${label}-screen.png`), screen.result.data)
  }
  checks.push('two distinct real local computers retain isolated guest files and produce actual PNGs')
  await environment.closeCliPalRuntime()
  const broker = new sdk.PalMessageBroker({ pals: (await loadCli('pals/store')).getCliPalStore(), store: inbox, host: communication.createCliPalMessageHost(), authorize: policy.authorize.bind(policy) })
  await broker.sender({ address: address(one), conversationId: origin, profileRevision: one.revision }).send({ operationId: 'native-revocation-proof', recipient: address(two), body: 'Accepted before revocation.' })
  runCli('revoke', one.id, two.id)
  const requestCount = reviewer.requests.length
  const refused = await dispatch.dispatchCliPalMessages(ctx, two.id, new AbortController().signal)
  assert.equal(refused.status, 'blocked')
  assert.equal(reviewer.requests.length, requestCount)
  assert.equal((await inbox.read(address(two))).messages.at(-1).phase, 'pending')
  checks.push('revoked directed permission blocks accepted input dispatch without another model request')
} finally {
  await agent?.close()
  await environment.closeCliPalRuntime()
  await originalRuntime?.close()
  sessions.closeSessions(state)
  sdk.ProviderRegistry.create = originalCreate
  globalThis.fetch = originalFetch
}
const receipt = {
  passed: true, platform: process.platform, node: process.version, checks,
  limitations: ['Built local consumer snapshot, not registry install.', 'Only model/discovery is scripted; no credentialed inference.', 'No external channels, continuous listener or native TUI message injection tested.'],
}
writeFileSync(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
