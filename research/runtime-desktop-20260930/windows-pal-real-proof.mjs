// Bundle this harness, then execute it with native Windows Node against the
// isolated built consumer snapshot. Only its own Pal and control home are used.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Operator } from '../../packages/desktop/src/main/operator.ts'

assert.equal(process.platform, 'win32')
const [snapshot] = process.argv.slice(2)
assert.ok(snapshot && basename(snapshot).startsWith('namzu-native-consumer-'))
const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
const packageFile = (name, file) => {
  const pkg = manifest.packages.find((item) => item.name === name)
  assert.ok(pkg, `Consumer snapshot has ${name}`)
  return join(snapshot, pkg.relative, file)
}
const sdk = await import(pathToFileURL(packageFile('@namzu/sdk', 'dist/index.js')).href)
const { createLocalVirtualComputerProvider } = await import(pathToFileURL(packageFile('@namzu/sandbox', 'dist/index.js')).href)
const home = join(snapshot, `pal-proof-${randomUUID()}`)
mkdirSync(home)
const env = { ...process.env, NAMZU_HOME: home, NAMZU_PAL_COMPUTER_ENGINE: 'podman' }
assert.ok(env.NAMZU_PAL_PODMAN_BINARY && env.NAMZU_PAL_PODMAN_MACHINE && env.NAMZU_PAL_PODMAN_CONNECTION)
const cli = join(snapshot, manifest.cli)
const creation = spawnSync(process.execPath, [cli, 'pal', 'create', 'Native Pal', '--purpose', 'Türkçe 🧪 guest proof', '--json'], { env, encoding: 'utf8', windowsHide: true })
assert.equal(creation.status, 0, creation.stderr)
const pal = JSON.parse(creation.stdout)
assert.equal(pal.purpose, 'Türkçe 🧪 guest proof')
const checks = ['native built CLI creates UTF-8 Pal in private home']
let claimedConversation
const owner = new Operator({ program: process.execPath, args: [cli, 'acp', '--desktop'], env }, () => {}, join(home, 'desktop-registry'))
try {
  assert.equal((await owner.listPals()).find((item) => item.id === pal.id)?.name, pal.name)
  const opened = await owner.openPal(pal.id)
  assert.equal(opened.project.palId, pal.id)
  assert.equal((await owner.palComputer(pal.id)).status, 'stopped')
  assert.equal((await owner.startPalComputer(pal.id)).status, 'ready')
  const screen = await owner.palScreen(pal.id)
  assert.equal(screen.width, 1280)
  assert.equal(screen.height, 800)
  writeFileSync(join(home, 'acp-screen.png'), Buffer.from(screen.source.split(',')[1], 'base64'))
  const conversation = await owner.newConversation(opened.project.id)
  assert.equal(conversation.palId, pal.id)
  claimedConversation = conversation.id
  checks.push('production desktop Operator -> native CLI ACP -> real owned Podman computer', 'actual PNG capture and claimed private conversation over production RPC')
} finally {
  await owner.close()
}
checks.push('production native CLI/ACP guest and owned process tree close confirmed')
process.stdout.write(JSON.stringify({ phase: 'native-cli-acp', checks }) + '\n')
process.stdout.write(JSON.stringify({ phase: 'parent-cwd', inherited: process.cwd() }) + '\n')

const store = new sdk.DiskPalStore({ root: join(home, 'pals'), workspaceRoot: join(dirname(home), `${basename(home)}-workspaces`, 'pals') })
const environments = createLocalVirtualComputerProvider({
  engine: 'podman', podmanBinary: env.NAMZU_PAL_PODMAN_BINARY,
  podmanMachine: env.NAMZU_PAL_PODMAN_MACHINE, podmanConnection: env.NAMZU_PAL_PODMAN_CONNECTION,
})
const runtime = new sdk.PalRuntime({ store, environments })
const sessionHost = await import(pathToFileURL(packageFile('@namzu/cli', 'dist/integrations/sessions/store.js')).href)
const sessions = await sessionHost.openSessions(pal.workspace, { stateRoot: home })
let admission
try {
  const conversationId = claimedConversation
  assert.ok(conversationId)
  admission = await runtime.admit({ palId: pal.id, conversationId })
  process.stdout.write(JSON.stringify({ phase: 'sdk-computer-admitted' }) + '\n')
  const lease = admission.lease
  const guest = new Proxy(lease.sandbox, { get(target, key) {
    if (key === 'destroy') return async () => {}
    const value = Reflect.get(target, key, target)
    if (typeof value !== 'function') return value
    return (...args) => { admission.assertActive(); return value.apply(target, args) }
  } })
  const provider = new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ name: 'write', args: { path: 'outputs/report.md', content: 'Türkçe 🧪 actual guest\n' } }] },
    { toolCalls: [{ name: 'read', args: { path: 'outputs/report.md' } }] },
    { toolCalls: [{ name: 'glob', args: { pattern: '**/*.md' } }] },
    { toolCalls: [{ name: 'grep', args: { pattern: 'actual guest', path: 'outputs' } }] },
    { toolCalls: [{ name: 'bash', args: { command: 'printf "os="; uname -s; printf "cwd="; pwd' } }] },
    { toolCalls: [{ name: 'computer_use', args: { type: 'screenshot' } }] },
    { text: 'Actual guest tool proof complete' },
  ] })
  const events = []
  const turn = await sdk.drainQuery({
    provider, toolsets: [sdk.toolset('native-guest-proof', [sdk.WriteFileTool, sdk.ReadFileTool, sdk.GlobTool, sdk.GrepTool, sdk.BashTool, sdk.createComputerUseTool(lease.computerUseHost, { settleMs: 0 })])],
    turnConfig: { model: 'fixture', timeoutMs: 60000, tokenBudget: 0, maxIterations: 10, maxResponseTokens: 256 },
    agentId: `pal:${pal.id}`, agentName: pal.name,
    messages: [sdk.createUserMessage('Exercise only your own guest tools')],
    workingDirectory: lease.sandbox.rootDir, sessionId: conversationId,
    paths: sessions.paths, sessionLog: sdk.DiskSessionLog.at(sessions.paths, { sessionId: conversationId }),
    topicId: sessions.topicId, projectId: sessions.projectId, tenantId: sessions.tenantId,
    sandboxEscape: 'refuse', outsideRootAccess: 'refuse',
    beforeStep: () => { admission.assertActive() },
    sandboxProvider: { id: `pal:${pal.id}`, name: 'Real Pal guest proof', environment: guest.environment, create: async () => guest },
  }, (event) => events.push(event))
  assert.equal(turn.status, 'completed')
  const tools = events.filter((event) => event.type === 'tool_completed')
  assert.equal(tools.length, 6)
  assert.ok(tools.every((event) => !event.isError), JSON.stringify(tools.map(({ toolName, isError, result }) => ({ toolName, isError, result: result.slice(0, 300) }))))
  assert.equal((await guest.readFile('/home/namzu/workspace/outputs/report.md')).toString(), 'Türkçe 🧪 actual guest\n')
  const shell = tools.find((event) => event.toolName === 'bash')
  assert.ok(shell.result.includes('os=Linux') && shell.result.includes('/home/namzu/workspace'))
  assert.ok(JSON.stringify(provider.requests).includes('Türkçe 🧪 actual guest'))
  assert.ok(JSON.stringify(provider.requests).includes('image/png'))
  checks.push('actual SDK query write/read/glob/grep/bash/computer_use in admitted Pal guest', 'Linux guest commands and UTF-8 file/screenshot observations reach fixture model')
  await admission.release()
  admission = undefined
  await runtime.stopComputer(pal.id)
  const reopened = await runtime.startComputer(pal.id)
  assert.equal((await reopened.sandbox.readFile('/home/namzu/workspace/outputs/report.md')).toString(), 'Türkçe 🧪 actual guest\n')
  checks.push('same Pal retains actual guest files after query and computer restart')
} finally {
  await admission?.release()
  await runtime.close()
  sessionHost.closeSessions(sessions)
}
const receipt = { passed: true, platform: process.platform, node: process.version, checks, limitations: ['Built local consumer snapshot, not a registry npm install.', 'Model provider is scripted; no credentialed inference or native TUI rendering.', 'External Teams transport and continuous Pal listener are not exercised.'] }
writeFileSync(join(home, 'receipt.json'), JSON.stringify(receipt, null, 2))
process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
