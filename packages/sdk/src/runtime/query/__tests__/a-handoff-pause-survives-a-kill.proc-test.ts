import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { SessionPaths } from '../../../session/paths.js'
import { DiskSessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { resumeSession } from '../resume-session.js'

/**
 * A turn a tool paused for a person is a promise that outlives the process
 * that made it. The worker SIGKILLs itself the moment its `turn_paused`
 * record is on disk — no settle, no lease release — and a second process
 * resumes the same turn: the next step is a model call that sees the tool's
 * result, and the tool does not run again.
 */

const worker = `
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const sdk = await import(pathToFileURL(process.argv[2]).href)
const { z } = await import(pathToFileURL(process.argv[5]).href)
const root = process.argv[3]
const ids = JSON.parse(process.argv[4])
const paths = new sdk.SessionPaths({ home: join(root, 'home'), slug: 'handoff' })
const locator = { sessionId: ids.sessionId }
class DyingLog extends sdk.DiskSessionLog {
  async append(lease, draft) {
    const entry = await super.append(lease, draft)
    if (draft.type === 'turn_paused') process.kill(process.pid, 'SIGKILL')
    return entry
  }
}
const sessionLog = new DyingLog({
  sessionId: ids.sessionId, file: paths.sessionLog(locator), sessionDir: paths.sessionDir(locator),
})
// A short lease: the next process may take the session soon after the kill.
const lease = await sessionLog.claim({ holder: 'handoff:' + process.pid, ttlMs: 400 })
const tools = sdk.toolset('handoff-worker', [{ name: 'open_page', description: 'opens a page', inputSchema: z.object({}), execute: async () => {
  await appendFile(join(root, 'ran'), 'x')
  return {
    success: false, output: 'The page is a sign-in form.', error: 'sign-in required',
    handoff: { kind: 'human-required', reason: 'Sign in to example.test, then continue.' },
  }
} }])
await sdk.drainQuery({
  ...ids, paths, sessionLog, lease, toolsets: [tools], workingDirectory: root, agentId: 'handoff', agentName: 'Handoff',
  provider: new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'c1', name: 'open_page', args: {} }], finishReason: 'tool_calls' },
    { text: 'the worker must never get here' },
  ] }),
  messages: [sdk.createUserMessage('open the page')],
  turnConfig: { model: 'mock', tokenBudget: 100000, maxIterations: 5, timeoutMs: 60000, permissionMode: 'auto' },
})
console.log('the worker was not killed')
`

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await removeTempDirAsync(root)
})

it('resumes a handoff pause in a new process after the first was killed', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-handoff-kill-'))
	roots.push(root)
	await mkdir(join(root, 'home'))
	const ids = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		topicId: generateTopicId(),
		sessionId: generateSessionId(),
		turnId: generateTurnId(),
	}
	const script = join(root, 'worker.mjs')
	await writeFile(script, worker)
	const sdk = fileURLToPath(new URL('../../../../dist/index.js', import.meta.url))
	const zod = fileURLToPath(import.meta.resolve('zod'))
	const child = spawn(process.execPath, [script, sdk, root, JSON.stringify(ids), zod], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	let output = ''
	child.stdout.on('data', (chunk) => {
		output += chunk
	})
	child.stderr.on('data', (chunk) => {
		output += chunk
	})
	const signal = await new Promise<NodeJS.Signals | null>((resolve) =>
		child.on('exit', (_code, sig) => resolve(sig)),
	)
	expect(signal, output).toBe('SIGKILL')
	expect(await readFile(join(root, 'ran'), 'utf8')).toBe('x')
	// Past the dead holder's lease.
	await new Promise((resolve) => setTimeout(resolve, 500))

	const paths = new SessionPaths({ home: join(root, 'home'), slug: 'handoff' })
	const sessionLog = DiskSessionLog.at(paths, { sessionId: ids.sessionId })
	const before = (await sessionLog.readAll()).entries.map((entry) => entry.record)
	const paused = before.at(-1) as { type: string; handoff?: { reason: string } }
	expect(paused.type).toBe('turn_paused')
	expect(paused.handoff?.reason).toBe('Sign in to example.test, then continue.')

	let ranAgain = 0
	const tools = testToolset({
		name: 'open_page',
		description: 'opens a page',
		inputSchema: z.object({}),
		execute: async () => {
			ranAgain += 1
			return { success: true, output: 'unexpected' }
		},
	})
	const provider = new MockLLMProvider({ turns: [{ text: 'signed in, carrying on' }] })
	const { turnId: _turnId, ...session } = ids
	const outcome = await resumeSession({
		...session,
		scope: ids,
		sessionLog,
		paths,
		provider,
		toolsets: [tools],
		workingDirectory: root,
		agentId: 'handoff',
		agentName: 'Handoff',
		turnConfig: { model: 'mock', tokenBudget: 100_000, maxIterations: 3, timeoutMs: 20_000 },
		resumeHandler: async () => ({ action: 'continue' as const }),
	})

	expect(outcome.resumed).toBe(true)
	if (!outcome.resumed) return
	expect(outcome.turn.id).toBe(ids.turnId)
	expect(outcome.turn.status).toBe('completed')
	expect(outcome.turn.result).toBe('signed in, carrying on')
	expect(ranAgain).toBe(0)
	expect(provider.requests).toHaveLength(1)
	expect(JSON.stringify(provider.requests[0]?.messages)).toContain('The page is a sign-in form.')
	const types = (await sessionLog.readAll()).entries.map((entry) => entry.record.type)
	expect(types.filter((type) => type === 'turn_started')).toHaveLength(1)
	expect(types.filter((type) => type === 'turn_paused')).toHaveLength(1)
	expect(types).toContain('turn_resuming')
	expect(types.at(-1)).toBe('turn_completed')
}, 60_000)
