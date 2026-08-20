import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

/**
 * A teardown deadline is part of the run, not background housekeeping.
 *
 * An awaited promise does not keep Node alive. If the deadline timer is
 * `unref()`'d and a third-party `destroy()` has no active handle of its own,
 * the process exits zero after `run_completed` but before `drainQuery()`
 * returns. A test runner supplies unrelated handles and cannot observe that,
 * so this case must run in a bare child against the built package entry.
 */

const dirs: string[] = []

afterEach(() => {
	for (const dir of dirs) removeTempDir(dir)
	dirs.length = 0
})

const SCRIPT = `
import { pathToFileURL } from 'node:url'
const sdk = await import(pathToFileURL(process.argv[2]).href)
const ZERO = { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 }

const provider = {
  id: 'scripted',
  name: 'Scripted',
  async *chatStream() {
    yield { id: 'm1', delta: { content: 'done' } }
    yield { id: 'm1', delta: {}, finishReason: 'stop', usage: ZERO }
  },
}
const sandbox = {
  id: 'sbx_process', status: 'ready', rootDir: '/workspace', environment: 'basic',
  async exec() { return { stdout: '', stderr: '', exitCode: 0, durationMs: 0, timedOut: false } },
  async writeFile() {}, async readFile() { return Buffer.alloc(0) }, async listFiles() { return [] },
  async destroy() { return await new Promise(() => {}) },
}

let last = '(none)'
sdk.drainQuery({
  provider,
  tools: new sdk.ToolRegistry(),
  sandboxProvider: { id: 'held', name: 'Held', environment: 'basic', async create() { return sandbox } },
  sandboxTeardownTimeoutMs: 20,
  agentId: 'a', agentName: 'A',
  messages: [{ role: 'user', content: 'go', timestamp: Date.now() }],
  workingDirectory: process.argv[3],
  runConfig: { model: 'm', timeoutMs: 20000, tokenBudget: 10000, maxIterations: 2 },
  sessionId: 'ses_x', topicId: 'top_x', projectId: 'prj_x', tenantId: 'tnt_x',
}, (event) => { last = event.type }).then(
  (run) => console.log('RESULT ' + JSON.stringify({ status: run.status, result: run.result, last })),
  (error) => console.log('THREW ' + (error?.message ?? error)),
)
process.on('exit', () => console.log('LAST ' + last))
`

describe('sandbox teardown keeps its own process alive', () => {
	it('returns the completed run after the teardown deadline', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-sandbox-teardown-process-'))
		dirs.push(dir)
		const script = join(dir, 'run.mjs')
		writeFileSync(script, SCRIPT)
		const sdkEntry = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url))

		const out = execFileSync(process.execPath, [script, sdkEntry, dir], {
			encoding: 'utf8',
			timeout: 60_000,
		})

		expect(out, `the run exited before teardown settled:\n${out}`).toContain('RESULT ')
		expect(out).toContain('"status":"completed"')
		expect(out).toContain('"result":"done"')
		expect(out).toContain('"last":"run_completed"')
	})
})
