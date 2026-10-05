// Isolated built-consumer proof. Run with native Windows Node; never uses a Pal/computer.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.equal(process.platform, 'win32', 'Use native Windows Node.')
const [fixtureArg, depsArg, outputArg] = process.argv.slice(2)
assert.ok(fixtureArg && depsArg && outputArg, 'Arguments: fresh fixture, existing consumer deps, receipt.')
const fixture = resolve(fixtureArg)
const deps = resolve(depsArg)
const sdkRoot = join(fixture, 'sdk')
assert.notEqual(fixture, deps)
assert.ok(fixture.includes('namzu-native-task-20261005-'))
assert.equal(JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).name, '@namzu/sdk')
const manifest = JSON.parse(readFileSync(join(deps, 'manifest.json'), 'utf8'))
const priorSdk = manifest.packages.find((pkg) => pkg.name === '@namzu/sdk')
assert.ok(priorSdk)
const modules = join(sdkRoot, 'node_modules')
assert.equal(existsSync(modules), false, 'Fixture must be new; no existing dependency links are modified.')
symlinkSync(join(deps, priorSdk.relative, 'node_modules'), modules, 'junction')
process.chdir(fixture)
process.env.NAMZU_HOME = join(fixture, 'state')
process.env.NAMZU_MODEL_CATALOGUE_REFRESH = '0'
mkdirSync(process.env.NAMZU_HOME)
const sourceFiles = [
  'dist/store/task/disk.js', 'dist/store/task/context.js', 'dist/tools/task/update.js',
  'dist/runtime/query/index.js', 'dist/bridge/acp/server.js', 'dist/bridge/acp/tasks.js',
  'dist/constants/acp/index.js', 'dist/public-runtime.js', 'package.json',
]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceHashes = sourceFiles.map((file) => ({ file: `sdk/${file}`, sha256: sha(readFileSync(join(sdkRoot, file))) }))
sourceHashes.push({ file: 'task-tracking-native-windows-20261005.mjs', sha256: sha(readFileSync(fileURLToPath(import.meta.url))) })
const checks = []
const facts = {}
const receipt = (passed, error) => ({
  passed, platform: process.platform, node: process.version,
  model: 'MockLLMProvider', networkCalls: 0, computerCalls: 0, modelCost: 0,
  fixture: 'fresh native Windows Temp directory; copied SDK build and existing dependency junction',
  checks, facts, sourceHashes,
  ...(error ? { error: { name: error.name, message: String(error.message).replaceAll(fixture, '<fixture>').replaceAll(deps, '<existing-deps>') } } : {}),
  limitations: [
    'This is a copied local SDK build, not an npm registry install.',
    'The model is scripted. Runtime tools, disk writes and ACP server are production SDK code.',
    'ACP transport is an in-process loopback, not the native desktop UI or stdio process.',
    'No CLI host authorization, Pal admission, live provider or user computer behavior is asserted.',
    'No existing application, profile, dependency tree or guest was modified.',
  ],
})
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

try {
  // Refuse an accidental fetch rather than reaching a provider/catalogue.
  globalThis.fetch = async () => { throw new Error('Network is disabled in this isolated proof.') }
  const sdk = await import(pathToFileURL(join(sdkRoot, 'dist/index.js')).href)
  const {
    ACPServer, ACP_TASK_CAPABILITY, DiskTaskStore, HostCommandRegistry,
    InMemorySessionLog, MockLLMProvider, SessionPaths, ToolManager,
    createToolPresenter, createUserMessage, drainQuery, generateProjectId,
    generateSessionId, generateTenantId, generateTopicId, generateTurnId,
    selectTaskContext,
  } = sdk
  const tenantId = generateTenantId()
  const sessionId = generateSessionId()
  const turnId = generateTurnId()
  const paths = new SessionPaths({ home: process.env.NAMZU_HOME, slug: 'native-task-proof' })
  const store = new DiskTaskStore({ paths, session: { sessionId }, tenantId })
  assert.deepEqual(await store.listStrict(), [])
  checks.push('Strict list accepts a not-yet-created task directory.')
  const blocker = await store.create({ sessionId, turnId, subject: 'Obtain source', owner: 'Researcher' })
  const dependent = await store.create({ sessionId, turnId, subject: 'Inspect outcome' })
  await store.block(blocker.id, dependent.id)
  await store.update(blocker.id, { status: 'failed' })
  const reopened = new DiskTaskStore({ paths, session: { sessionId }, tenantId })
  const rows = await reopened.listStrict()
  assert.equal(rows.find((task) => task.id === blocker.id).status, 'failed')
  assert.equal(typeof rows.find((task) => task.id === blocker.id).completedAt, 'number')
  assert.deepEqual(rows.find((task) => task.id === dependent.id).blockedBy, [blocker.id])
  assert.ok(rows.every((task) => task.sessionId === sessionId && task.tenantId === tenantId))
  checks.push('Native Windows disk reopening retains failed status, ownership and dependencies.')
  assert.deepEqual(selectTaskContext(rows, { turnId: generateTurnId(), turnStartedAt: Number.MAX_SAFE_INTEGER }).map((task) => task.id), [dependent.id])
  checks.push('Canonical selector omits an earlier terminal failure and retains unfinished work.')
  assert.equal(await reopened.delete(blocker.id), true)
  assert.deepEqual((await reopened.listStrict()).map((task) => ({ id: task.id, blockedBy: task.blockedBy })), [{ id: dependent.id, blockedBy: [] }])
  checks.push('Deletion removes the actual task file and clears the remaining dependency edge.')
  await writeFile(paths.taskFile({ sessionId }, dependent.id), '{broken json')
  await assert.rejects(() => reopened.listStrict())
  assert.deepEqual(await reopened.list(), [])
  checks.push('Corrupt task record rejects a strict snapshot while tolerant-list compatibility remains.')
  const invalidSession = generateSessionId()
  const invalidStore = new DiskTaskStore({ paths, session: { sessionId: invalidSession }, tenantId })
  await invalidStore.create({ sessionId: invalidSession, turnId, subject: 'Directory failure' })
  const invalidDirectory = paths.tasks({ sessionId: invalidSession })
  await rename(invalidDirectory, `${invalidDirectory}.saved`)
  await writeFile(invalidDirectory, 'not a directory')
  await assert.rejects(() => invalidStore.listStrict())
  checks.push('A file occupying the tasks directory rejects an authoritative list on Windows.')

  const runtimeSession = generateSessionId()
  const runtimeTurn = generateTurnId()
  const runtimeStore = new DiskTaskStore({ paths, session: { sessionId: runtimeSession }, tenantId })
  const workingDirectory = join(fixture, 'workspace')
  mkdirSync(workingDirectory)
  let sourceTask
  let dependentTask
  const actualEvents = []
  const provider = new MockLLMProvider({ nextTurn: (_request, index) => {
    switch (index) {
      case 0: return { toolCalls: [{ name: 'task_create', args: { subject: 'Obtain source', description: 'PRIVATE description', metadata: { value: 'PRIVATE metadata' }, owner: 'Researcher' } }] }
      case 1: return { toolCalls: [{ name: 'task_create', args: { subject: 'Inspect outcome', blockedBy: [sourceTask] } }] }
      case 2: return { toolCalls: [{ name: 'task_update', args: { id: sourceTask, status: 'failed' } }] }
      case 3: return { toolCalls: [{ name: 'task_list', args: {} }] }
      case 4: return { toolCalls: [{ name: 'task_update', args: { id: dependentTask, status: 'completed' } }] }
      case 5: return { toolCalls: [{ name: 'task_update', args: { id: sourceTask, status: 'deleted' } }] }
      default: return { text: 'The planning outcome has been recorded.' }
    }
  } })
  const entered = deferred()
  const release = deferred()
  const queryEnded = deferred()
  let receive
  let firstTaskBlocked = false
  let promptSettled = false
  let finalRun
  const sent = []
  const replies = new Map()
  const transport = {
    connect: async () => {}, close: async () => {}, isConnected: () => true,
    onMessage: (handler) => { receive = handler }, onClose: () => {}, onError: () => {},
    send: async (message) => {
      if (message.method === 'namzu/tasks/update' && !firstTaskBlocked) {
        firstTaskBlocked = true
        entered.resolve()
        await release.promise
      }
      sent.push(message)
      if (message.method === undefined && replies.has(message.id)) {
        replies.get(message.id)(message)
        replies.delete(message.id)
      }
    },
  }
  const server = new ACPServer({
    transport, supportsTaskNotifications: true,
    gateway: { prompt: async ({ onEvent, signal }) => {
      try {
        finalRun = await drainQuery({
          provider, toolsets: [], taskStore: runtimeStore,
          runtimeToolOverrides: { task_create: 'active', task_update: 'active', task_list: 'active' },
          sandboxProvider: false, signal,
          agentId: 'windows-task-proof', agentName: 'Windows task proof',
          messages: [createUserMessage('Track and inspect the planned work.')], workingDirectory,
          sessionId: runtimeSession, turnId: runtimeTurn, tenantId,
          projectId: generateProjectId(), topicId: generateTopicId(),
          sessionLog: new InMemorySessionLog({ sessionId: runtimeSession }),
          turnConfig: { model: 'mock-model', tokenBudget: 0, timeoutMs: 0, maxIterations: 12, maxResponseTokens: 256 },
        }, (event) => {
          actualEvents.push(event)
          if (event.type === 'task_created') {
            if (event.subject === 'Obtain source') sourceTask = event.taskId
            if (event.subject === 'Inspect outcome') dependentTask = event.taskId
          }
          onEvent(event)
        })
        return { stopReason: finalRun.stopReason }
      } finally { queryEnded.resolve() }
    } },
    commands: new HostCommandRegistry(),
    presenter: createToolPresenter(new ToolManager({ toolsets: [], messages: () => [] })),
    agentInfo: { name: 'namzu', version: 'isolated-native-proof' },
    newSessionId: () => runtimeSession,
  })
  let sequence = 0
  const request = (method, params = {}) => new Promise((done) => {
    const id = ++sequence
    replies.set(id, done)
    receive({ jsonrpc: '2.0', id, method, params })
  })
  try {
    await server.start()
    const initialized = await request('initialize', { capabilities: ['permission', ACP_TASK_CAPABILITY] })
    assert.ok(initialized.result.optionalClientCapabilities.includes(ACP_TASK_CAPABILITY))
    await request('session/new')
    const prompt = request('session/prompt', { sessionId: runtimeSession, prompt: 'Inspect planned work.' }).then((result) => { promptSettled = true; return result })
    await entered.promise
    await queryEnded.promise
    assert.equal(promptSettled, false, 'ACP may not settle while an admitted task notification is held.')
    release.resolve()
    const result = await prompt
    assert.equal(result.error, undefined)
    assert.equal(finalRun.status, 'completed')
    assert.equal(finalRun.stopReason, 'end_turn')
    assert.equal(provider.requests.length, 7)
    assert.deepEqual(provider.requests[0].tools.map((tool) => tool.function.name).sort(), ['task_create', 'task_list', 'task_update'])
    assert.ok(actualEvents.filter((event) => event.type === 'tool_completed').every((event) => event.isError !== true))
    checks.push('Actual native drainQuery generated and executed planning tools with a local MockLLMProvider; no guest or host computer tools mounted.')
    const updates = sent.filter((message) => message.method === 'namzu/tasks/update').map((message) => message.params)
    assert.ok(updates.length >= 6)
    assert.ok(updates.every((update) => update.sessionId === runtimeSession))
    assert.ok(updates.some((update) => update.task.taskId === dependentTask && update.task.blockedBy.includes(sourceTask)))
    assert.ok(updates.some((update) => update.task.taskId === sourceTask && update.task.status === 'failed'))
    assert.ok(updates.some((update) => update.task.taskId === sourceTask && update.deleted === true && update.task.status === 'failed'))
    assert.ok(updates.some((update) => update.task.taskId === dependentTask && update.task.status === 'completed' && update.task.blockedBy.length === 0))
    assert.ok(updates.every((update) => Object.keys(update.task).every((key) => ['taskId', 'subject', 'status', 'blockedBy', 'owner'].includes(key))))
    assert.equal(JSON.stringify(updates).includes('PRIVATE'), false)
    assert.ok(sent.findIndex((message) => message.method === 'namzu/tasks/update') < sent.findIndex((message) => message.method === 'session/update' && message.params.update?.kind === 'turn_ended'))
    checks.push('Negotiated ACP task notifications preserve full replacement rows, failure, dependency clears and deletion without private description/metadata.')
    checks.push('Task notification transport delivery completes before the prompt response; order survives a deliberately deferred first write.')
    const durable = await new DiskTaskStore({ paths, session: { sessionId: runtimeSession }, tenantId }).listStrict()
    assert.deepEqual(durable.map((task) => ({ subject: task.subject, status: task.status, blockedBy: task.blockedBy })), [{ subject: 'Inspect outcome', status: 'completed', blockedBy: [] }])
    checks.push('Real runtime task changes are durable on disk after the query and ACP server settle.')
    facts.runtime = { modelRequests: provider.requests.length, planningEvents: actualEvents.filter((event) => event.type === 'task_created' || event.type === 'task_updated').length, sideNotifications: updates.length, finalTaskCount: durable.length, finalTaskStatus: durable[0].status }
  } finally {
    release.resolve()
    await server.stop()
  }
  facts.sdkBuild = { copiedDistRootEntries: readdirSync(join(sdkRoot, 'dist')).length, dependencyLinkType: 'native Windows junction', existingConsumerUnmodified: true }
  writeFileSync(outputArg, `${JSON.stringify(receipt(true), null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ passed: true, platform: process.platform, node: process.version, checks: checks.length, facts })}\n`)
} catch (error) {
  writeFileSync(outputArg, `${JSON.stringify(receipt(false, error), null, 2)}\n`)
  process.stderr.write(`${error.name}: ${String(error.message).replaceAll(fixture, '<fixture>').replaceAll(deps, '<existing-deps>')}\n`)
  process.exitCode = 1
}
