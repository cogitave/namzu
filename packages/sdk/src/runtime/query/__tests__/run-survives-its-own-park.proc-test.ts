import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

/**
 * A run has to survive its own waiting.
 *
 * Every HITL park went through a timer that was deliberately `unref`'d, so a
 * pending park-recorder could never hold a process open after the run
 * settled. The intent was right and the scope was wrong: the run AWAITS that
 * timer, mid-turn, on every park. An unref'd timer does not keep Node's loop
 * alive — so once the decision resolved and the run sat out the rest of the
 * delay, the loop had nothing ref'd left in it and the process exited. Mid
 * turn. Exit code 0. No terminal event, no error, and nothing done.
 *
 * The headless surfaces could not finish a turn at all: the first tool call
 * completed and the process ended.
 *
 * **This test spawns a child process on purpose.** In-process it is
 * unwritable — a test runner holds the event loop open for the whole file,
 * which is the exact prop that hid this for as long as it was hidden. Every
 * existing test passed throughout. If you are tempted to rewrite this as an
 * ordinary `drainQuery` call because spawning is slow, that rewrite is the
 * bug coming back.
 *
 * It loads the BUILT entry point, because that is what a consumer loads and
 * because a child process cannot resolve TypeScript. The `test:proc` script
 * therefore builds first — a stale `dist` reports a failure that has nothing
 * to do with the code under test, and would report a pass just as
 * confidently.
 */

const workdirs: string[] = []
afterEach(() => {
	for (const dir of workdirs) removeTempDir(dir)
	workdirs.length = 0
})

/**
 * A scripted provider and a run, in a file with no test runner under it.
 *
 * Two turns: one tool call, then an answer. The park happens between them,
 * which is where the process used to die.
 */
const SCRIPT = `
import { pathToFileURL } from 'node:url'
const sdk = await import(pathToFileURL(process.argv[2]).href)
const { ToolRegistry, drainQuery, defineTool } = sdk
const { z } = await import(pathToFileURL(process.argv[3]).href)

const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }

let calls = 0
const provider = {
  id: 'scripted',
  name: 'Scripted',
  async *chatStream() {
    calls += 1
    if (calls === 1) {
      yield { id: 'm1', delta: { toolCalls: [{ index: 0, id: 't1', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }
      yield { id: 'm1', delta: {}, finishReason: 'tool_calls', usage: ZERO }
      return
    }
    yield { id: 'm2', delta: { content: 'answered' } }
    yield { id: 'm2', delta: {}, finishReason: 'stop', usage: ZERO }
  },
}

const tools = new ToolRegistry()
tools.register(defineTool({
  name: 'ping',
  description: 'pings',
  inputSchema: z.object({}),
  category: 'analysis',
  permissions: [],
  readOnly: true,
  destructive: false,
  concurrencySafe: true,
  async execute() { return { success: true, output: 'pong' } },
}))

let last = '(none)'
drainQuery({
  provider,
  tools,
  agentId: 'a',
  agentName: 'A',
  messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
  workingDirectory: process.argv[4],
  runConfig: { model: 'm', timeoutMs: 20000, tokenBudget: 10000, maxIterations: 4, maxResponseTokens: 128 },
  sessionId: 'ses_x', threadId: 'thd_x', projectId: 'prj_x', tenantId: 'tnt_x',
}, (e) => { last = e.type }).then(
  (run) => console.log('RESULT ' + JSON.stringify({ status: run.status, stop: run.stopReason, last })),
  (err) => console.log('THREW ' + (err?.message ?? err)),
)
process.on('exit', () => console.log('LAST ' + last))
`

describe('a run outlives its own HITL park', () => {
	it('finishes in a process with nothing else holding the event loop open', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-park-'))
		workdirs.push(dir)
		const script = join(dir, 'run.mjs')
		writeFileSync(script, SCRIPT)

		// `fileURLToPath`, not `pathname` with the leading slash stripped. That
		// stripping is right on Windows, where `pathname` is `/C:/…`, and wrong
		// everywhere else, where it turns an absolute POSIX path into a
		// relative one — which is how this passed locally and failed in CI with
		// the repo root pasted in front of itself.
		const sdkEntry = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url))
		const zodEntry = require.resolve('zod')

		const out = execFileSync(process.execPath, [script, sdkEntry, zodEntry, dir], {
			encoding: 'utf8',
			timeout: 60_000,
		})

		// The run reached its own end rather than the process reaching it first.
		expect(out, `the run did not complete:\n${out}`).toContain('RESULT ')
		expect(out).toContain('"status":"completed"')
		expect(out).toContain('"last":"run_completed"')
	}, 90_000)
})
