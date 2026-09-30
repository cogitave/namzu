import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.argv[2]
assert(root, 'Pass the installed Namzu checkout as the first argument')
const source = (path: string) => pathToFileURL(join(root, path)).href
const sdk = await import(source('packages/sdk/dist/index.js'))
const { createTaskContextStep } = await import(source('packages/cli/src/integrations/sessions/task-context.ts'))
const fixture = await mkdtemp(join(tmpdir(), 'namzu-workflow-probe-'))
const sessionId = sdk.generateSessionId()
const tenantId = sdk.generateTenantId()
const taskStore = new sdk.InMemoryTaskStore()
const marker = 'SYNTHETIC_AGENT_TASK_DATA_20260930'
await taskStore.create({
  sessionId,
  tenantId,
  turnId: sdk.generateTurnId(),
  subject: marker,
  description: 'Synthetic stored planning text, not host policy.',
})
const requests: any[] = []
const provider = new sdk.MockLLMProvider({
  responseText: 'Synthetic probe completed.',
  onRequest: (request: any) => requests.push(structuredClone(request)),
})
await sdk.drainQuery({
  provider,
  toolsets: [],
  turnConfig: { model: 'synthetic', timeoutMs: 10000, tokenBudget: 100000, maxIterations: 2, maxResponseTokens: 256 },
  agentId: 'workflow-probe',
  agentName: 'Workflow probe',
  messages: [sdk.createUserMessage('Inspect the synthetic fixture.')],
  workingDirectory: fixture,
  sessionId,
  tenantId,
  topicId: sdk.generateTopicId(),
  projectId: sdk.generateProjectId(),
  prepareStep: createTaskContextStep(taskStore, tenantId),
})
assert.equal(requests.length, 1)
const markerRoles = requests[0].messages.filter((m: any) => JSON.stringify(m.content).includes(marker)).map((m: any) => ({ role: m.role, source: m.source ?? null }))
console.log(JSON.stringify({ probe: 'task-provider-role', requests: requests.length, markerRoles }))

const require = createRequire(import.meta.url)
const { z } = createRequire(join(root, 'packages/sdk/package.json'))('zod')
const executions: string[] = []
let repaired = false
let attempt = 0
const declarations = ['check', 'repair'].map((name) => sdk.defineTool({
  name,
  description: 'Synthetic fixture ' + name,
  inputSchema: z.object({}),
  category: 'analysis',
  permissions: [],
  readOnly: name === 'check',
  destructive: false,
  concurrencySafe: true,
  execute: async () => {
    executions.push(name)
    if (name === 'repair') {
      repaired = true
      return { success: true, output: 'Synthetic state repaired.' }
    }
    attempt++
    return repaired
      ? { success: true, output: 'The changed state now passes.' }
      : { success: false, output: '', error: 'Different synthetic failure ' + attempt }
  },
}))
const loopTurns = ['check', 'check', 'check', 'check', 'repair', 'check'].map((name, i) => ({
  toolCalls: [{ id: 'workflow-call-' + i, name, args: {} }],
  finishReason: 'tool_calls',
}))
const loop = await sdk.drainQuery({
  provider: new sdk.MockLLMProvider({ turns: [...loopTurns, { text: 'Done.' }] }),
  toolsets: [sdk.toolset('workflow-probe', declarations)],
  turnConfig: { model: 'synthetic', timeoutMs: 10000, tokenBudget: 200000, maxIterations: 8 },
  agentId: 'workflow-loop-probe',
  agentName: 'Workflow loop probe',
  messages: [sdk.createUserMessage('Check, repair the fixture, then check again.')],
  workingDirectory: fixture,
  sessionId: sdk.generateSessionId(),
  tenantId,
  topicId: sdk.generateTopicId(),
  projectId: sdk.generateProjectId(),
})
const refusal = loop.messages.filter((m: any) => m.role === 'tool' && typeof m.content === 'string' && m.content.includes('Refused:'))
console.log(JSON.stringify({ probe: 'retry-after-progress', repaired, executions, refusal: refusal.map((m: any) => m.content) }))

const fsPromises = require('node:fs/promises')
const originalRead = fsPromises.readFile
let reads = 0
let bytes = 0
let measuredDir = ''
fsPromises.readFile = async (...args: any[]) => {
  const result = await originalRead(...args)
  if (String(args[0]).startsWith(measuredDir + sep) && String(args[0]).endsWith('.md')) {
    reads++
    bytes += typeof result === 'string' ? Buffer.byteLength(result) : result.byteLength
  }
  return result
}
syncBuiltinESMExports()
try {
  for (const count of [10, 100, 500]) {
    const directory = join(fixture, 'memory-' + count)
    await mkdir(directory)
    for (let i = 0; i < count; i++) {
      const name = 'probe-' + String(i).padStart(4, '0')
      const raw = ['---', 'schemaVersion: 1', 'name: ' + name, 'description: Synthetic memory fixture', 'type: project', 'createdAt: 1', 'updatedAt: 1', '---', i === 0 ? 'unique-search-hit' : 'irrelevant', 'x'.repeat(16384)].join('\n')
      await writeFile(join(directory, name + '.md'), raw)
    }
    const store = new sdk.MarkdownMemoryStore({ directory })
    measuredDir = directory
    reads = 0
    bytes = 0
    const result = await store.list({ query: 'unique-search-hit', limit: 1 })
    console.log(JSON.stringify({ probe: 'markdown-search-io', files: count, limit: 1, returned: result.entries?.length ?? result.memories?.length ?? null, reads, bytes, resultKeys: Object.keys(result) }))
    assert.equal(result.entries.length, 1)
    assert(reads > 0, 'Read instrumentation must observe at least the matched record')
  }
} finally {
  fsPromises.readFile = originalRead
  syncBuiltinESMExports()
}
console.log(JSON.stringify({ fixture, network: 'No external provider or subprocess requested.' }))
