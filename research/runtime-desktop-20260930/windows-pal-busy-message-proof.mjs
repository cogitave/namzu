// Cross-process message during an actual guest-bound Pal query. Provider turns
// are scripted; completion uses explicit promise barriers, never a timed race.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32')
const [snapshot, home, mode] = process.argv.slice(2)
assert.ok(basename(snapshot).startsWith('namzu-native-consumer-'))
assert.ok(home.startsWith(snapshot) && basename(home).startsWith('pal-messaging-'))
assert.equal(JSON.parse(readFileSync(join(home, 'receipt.json'), 'utf8')).passed, true)
process.env.NAMZU_HOME = home
process.env.NAMZU_PAL_COMPUTER_ENGINE = 'podman'
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const load = (name, file) => {
  const pkg = manifest.packages.find((item) => item.name === name)
  assert.ok(pkg)
  return import(pathToFileURL(join(snapshot, pkg.relative, `dist/${file}.js`)).href)
}
const sdk = await load('@namzu/sdk', 'index')
const storeHost = await load('@namzu/cli', 'pals/store')
const sessionHost = await load('@namzu/cli', 'integrations/sessions/store')
const communication = await load('@namzu/cli', 'pals/communication')
const store = storeHost.getCliPalStore()
const pals = store.list()
const one = pals.find((pal) => pal.name === 'Local researcher')
const two = pals.find((pal) => pal.name === 'Local reviewer')
assert.ok(one && two && pals.length === 2)
const state = await sessionHost.openSessions(one.workspace)
const address = (pal) => ({ tenantId: state.tenantId, palId: pal.id })
const inbox = communication.cliPalCommunicationStore()
const policy = communication.cliPalCommunicationPolicy()
const reviewed = (await inbox.read(address(two))).messages.find((message) => message.phase === 'recorded')
const reviewerRoute = (await inbox.read(address(two))).routes.find((route) => route.id === reviewed.routeId)
const originalSession = reviewed.source.conversationId
const marker = 'NATIVE_CROSS_PROCESS_BUSY_MESSAGE Türkçe 🧪'
if (mode === '--sender') {
  try {
    const broker = new sdk.PalMessageBroker({ pals: store, store: inbox, authorize: policy.authorize.bind(policy), host: communication.createCliPalMessageHost() })
    const receipt = await broker.sender({ address: address(two), conversationId: reviewerRoute.sessionId, profileRevision: reviewerRoute.profileRevision }).send({ operationId: `busy-message-${process.pid}`, recipient: address(one), body: marker, replyTo: reviewed.id })
    process.stdout.write(JSON.stringify({ messageId: receipt.id, sessionId: receipt.sessionId, status: receipt.status }) + '\n')
  } finally { sessionHost.closeSessions(state) }
} else {
  const tui = await load('@namzu/cli', 'tui/agent')
  const palTui = await load('@namzu/cli', 'pals/tui-session')
  const environment = await load('@namzu/cli', 'pals/environment')
  const providers = await load('@namzu/cli', 'integrations/providers/index')
  const events = []
  const fixture = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: `native-busy-read-${process.pid}`, name: 'read', args: { path: 'sender-private.md' } }] },
    { text: 'Busy message observed after the complete tool result.' },
  ] })
  const nativeStream = fixture.chatStream.bind(fixture)
  let entered
  let release
  const firstEntered = new Promise((resolve) => { entered = resolve })
  const firstRelease = new Promise((resolve) => { release = resolve })
  let calls = 0
  let accepted
  fixture.chatStream = async function* (params) {
    if (calls++ === 0) {
      entered()
      await firstRelease
    } else {
      assert.equal((await inbox.read(address(one))).messages.find((message) => message.id === accepted.messageId).phase, 'recorded')
    }
    yield* nativeStream(params)
  }
  const originalCreate = sdk.ProviderRegistry.create
  let agent
  let work
  try {
    await providers.ensureRegistered('ollama')
    sdk.ProviderRegistry.create = () => ({ provider: fixture, capabilities: fixture.capabilities })
    const scope = { sessionId: originalSession, tenantId: state.tenantId, projectId: state.projectId, topicId: state.topicId }
    agent = await tui.createAgentSession({ version: 3, providers: [{ id: 'ollama', model: 'native-sender' }] }, [], {
      cwd: one.workspace, scope, conversationSessions: state, permissionMode: 'auto',
      palEnvironment: await palTui.tuiPalEnvironment(one, originalSession),
      onSessionEvent: (event) => events.push(event),
    })
    const history = await sessionHost.loadConversation(state, originalSession)
    work = (async () => {
      for await (const event of agent.send([...history, sdk.createUserMessage('Read your local file while receiving explicit peer input.')], { limits: { maxIterations: 4 } }))
        assert.notEqual(event.kind, 'error', JSON.stringify(event))
    })()
    // This is the actual provider-entry barrier under a live Pal admission.
    await Promise.race([firstEntered, work.then(() => { throw new Error('Fixture query ended before the provider barrier.') })])
    const runtime = await environment.getCliPalRuntime()
    assert.equal(runtime.busy(one.id), true)
    const result = spawnSync(process.execPath, [process.argv[1], snapshot, home, '--sender'], { env: process.env, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    accepted = JSON.parse(result.stdout)
    assert.equal(accepted.sessionId, originalSession)
    assert.equal((await inbox.read(address(one))).messages.find((message) => message.id === accepted.messageId).phase, 'pending')
    release()
    await work
    assert.equal(fixture.requests.length, 2)
    assert.ok(!JSON.stringify(fixture.requests[0].messages).includes(marker))
    assert.ok(JSON.stringify(fixture.requests[1].messages).includes(marker))
    assert.ok(JSON.stringify(fixture.requests[1].messages).includes('SENDER_PRIVATE_GUEST_FILE'))
    const recorded = (await inbox.read(address(one))).messages.find((message) => message.id === accepted.messageId)
    assert.equal(recorded.phase, 'recorded')
    const log = sdk.DiskSessionLog.at(state.paths, { sessionId: originalSession })
    const entries = (await log.readAll({ expectHead: recorded.receipt.through.pointer })).entries
    const inputIndex = entries.findIndex(({ record }) => record.type === 'message' && record.messageId === recorded.receipt.messageId)
    const toolIndex = entries.findLastIndex(({ record }) => record.type === 'tool_completed' && record.turnId === recorded.receipt.turnId)
    assert.ok(toolIndex >= 0 && inputIndex > toolIndex)
    assert.equal(events.filter((event) => event.type === 'tool_completed').length, 1)
    const receipt = { passed: true, platform: process.platform, checks: [
      'a second native process accepts an explicit message while the original guest-bound Pal query is busy',
      'acceptance retains the original conversation and is pending while the provider barrier is held',
      'SDK drains only after the complete assistant tool call/result pair',
      'exact real log receipt is recorded before the next provider entry',
      'actual guest read and peer context both reach the second scripted provider request',
    ], limitations: ['Native CLI AgentSession/query, not rendered TUI keyboard input.', 'Model provider is scripted; sender is a fixture-owned authorized host broker.', 'No external channel or automatic listener.'] }
    writeFileSync(join(home, 'busy-receipt.json'), JSON.stringify(receipt, null, 2))
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
  } finally {
    release?.()
    await work?.catch(() => {})
    await agent?.close()
    await environment.closeCliPalRuntime()
    sessionHost.closeSessions(state)
    sdk.ProviderRegistry.create = originalCreate
  }
}
