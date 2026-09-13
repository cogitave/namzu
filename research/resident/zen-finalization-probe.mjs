// Two explicit bounded live calls: a no-tools provider request and a normal built-CLI run.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { collectChatCompletion } from '../../packages/sdk/dist/index.js'
import { ZenProvider } from '../../packages/providers/zen/dist/index.js'

if (!process.argv.includes('--live'))
  throw new Error('Use --live explicitly; this probe calls Muse low.')
const model = 'muse-spark-1.3-contributor-free'
const root = await mkdtemp(join(tmpdir(), 'namzu-zen-finalize-'))
const repo = fileURLToPath(new URL('../../', import.meta.url))
const home = join(root, 'home'),
  cwd = join(root, 'workspace')
await mkdir(home, { mode: 0o700 })
await mkdir(cwd)
await writeFile(
  join(home, 'preferences.json'),
  JSON.stringify({ version: 3, providers: [{ id: 'zen', model }], subagents: { active: [] } }),
)
await writeFile(join(home, 'config.yaml'), 'web:\n  search: off\nsandbox:\n  enabled: false\n')
const original = globalThis.fetch
const requests = []
const report = { root, model, effort: 'low', requests, startedAt: Date.now() }
try {
  report.adapterSha256 = createHash('sha256')
    .update(await readFile(join(repo, 'packages/providers/zen/dist/options.js')))
    .digest('hex')
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body))
    requests.push({
      model: body.model,
      toolChoice: body.tool_choice ?? null,
      tools: body.tools?.length ?? 0,
    })
    return original(input, init)
  }
  const result = await collectChatCompletion(
    new ZenProvider().chatStream({
      model,
      effort: 'low',
      maxTokens: 512,
      signal: AbortSignal.timeout(45000),
      messages: [{ role: 'user', content: 'Reply only ready.' }],
      toolChoice: 'none',
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a file',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    }),
  )
  report.provider = {
    output: result.message.content,
    finishReason: result.finishReason,
    usage: result.usage,
  }
  assert.equal(result.message.content?.trim(), 'ready')
  assert.equal(result.message.toolCalls?.length ?? 0, 0)
  assert.deepEqual(requests, [{ model, toolChoice: null, tools: 0 }])
  globalThis.fetch = original
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      join(repo, 'packages/cli/dist/bin.js'),
      '--quiet',
      'run',
      'Reply only ready. Do not use tools.',
      '--trust',
      '--cwd',
      cwd,
      '--provider',
      'zen',
      '--model',
      model,
      '--effort',
      'low',
      '--max-iterations',
      '2',
      '--token-budget',
      '6000',
    ],
    { cwd, env: { ...process.env, NAMZU_HOME: home }, timeout: 60000, maxBuffer: 1024 * 1024 },
  )
  report.cli = { stdout, stderr, exit: 0 }
  assert.equal(stdout.trim(), 'ready')
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error)
  if (error.stdout !== undefined)
    report.cli = { stdout: error.stdout, stderr: error.stderr, exit: error.code }
  process.exitCode = 1
} finally {
  globalThis.fetch = original
  report.finishedAt = Date.now()
  await writeFile(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
}
