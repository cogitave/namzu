import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { SessionPaths } from '../../../session/paths.js'
import { DiskSessionLog } from '../../../store/session-log/index.js'
import type { ProjectId, SessionId, TenantId, TopicId, TurnId } from '../../../types/ids/index.js'
import { type AssistantMessage, createUserMessage } from '../../../types/message/index.js'
import { TurnInProgressError } from '../../../types/session/turn.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { resumeSession } from '../resume-session.js'

/**
 * A turn whose process is SIGKILLed leaves its session log with an open turn
 * and a lease nobody renews. Reopening the session must say so rather than
 * quietly start over: a new turn is refused with `state: 'interrupted'`,
 * `abandonInterrupted` closes the dead turn with `turn_failed{interrupted}`
 * first, and `resumeSession` continues the same `turnId` from its checkpoint.
 *
 * A real process and a real kill, because only then is nothing in memory
 * left to finish the turn.
 */

const worker = `
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const sdk = await import(pathToFileURL(process.argv[2]).href)
const { z } = await import(pathToFileURL(process.argv[5]).href)
const root = process.argv[3]
const ids = JSON.parse(process.argv[4])
const paths = new sdk.SessionPaths({ home: join(root, 'home'), slug: 'killed' })
const log = sdk.DiskSessionLog.at(paths, { sessionId: ids.sessionId })
// A short lease: the next process may take the session soon after the kill.
const lease = await log.claim({ holder: 'doomed:' + process.pid, ttlMs: 400 })
const tools = new sdk.ToolRegistry()
tools.register({ name: 'fast', description: 'returns', inputSchema: z.object({}), execute: async () => ({ success: true, output: 'fast done' }) })
tools.register({ name: 'block', description: 'never returns', inputSchema: z.object({}), execute: async () => {
  await writeFile(join(root, 'blocked'), 'yes')
  await new Promise(() => {})
} })
await sdk.drainQuery({
  ...ids, paths, lease, tools, workingDirectory: root, agentId: 'doomed', agentName: 'Doomed',
  provider: new sdk.MockLLMProvider({ turns: [
    { toolCalls: [{ id: 'c1', name: 'fast', args: {} }], finishReason: 'tool_calls' },
    { toolCalls: [{ id: 'c2', name: 'block', args: {} }], finishReason: 'tool_calls' },
  ] }),
  messages: [sdk.createUserMessage('work until killed')],
  turnConfig: { model: 'mock', tokenBudget: 100000, maxIterations: 5, timeoutMs: 60000, permissionMode: 'auto' },
  resumeHandler: async () => ({ action: 'continue' }),
})
`

interface Killed {
	readonly root: string
	readonly paths: SessionPaths
	readonly ids: {
		readonly tenantId: TenantId
		readonly projectId: ProjectId
		readonly topicId: TopicId
		readonly sessionId: SessionId
		readonly turnId: TurnId
	}
}

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await removeTempDirAsync(root)
})

/** Start a turn in its own process, let it checkpoint, SIGKILL it inside a tool. */
async function killedTurn(): Promise<Killed> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-killed-turn-'))
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
		stdio: ['ignore', 'ignore', 'pipe'],
	})
	let stderr = ''
	child.stderr.on('data', (chunk) => {
		stderr += chunk
	})
	const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
	const deadline = Date.now() + 20_000
	while (!existsSync(join(root, 'blocked'))) {
		if (child.exitCode !== null) throw new Error(`the worker exited early: ${stderr}`)
		if (Date.now() > deadline) throw new Error(`the worker never reached the tool: ${stderr}`)
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	child.kill('SIGKILL')
	await exited
	// Past the dead holder's lease.
	await new Promise((resolve) => setTimeout(resolve, 500))
	return { root, paths: new SessionPaths({ home: join(root, 'home'), slug: 'killed' }), ids }
}

/** Everything a turn on the killed session needs, except which turn. */
function params(killed: Killed, provider: MockLLMProvider) {
	const { turnId: _turn, ...session } = killed.ids
	return {
		...session,
		paths: killed.paths,
		provider,
		tools: new ToolRegistry(),
		workingDirectory: killed.root,
		agentId: 'next',
		agentName: 'Next',
		turnConfig: { model: 'mock', tokenBudget: 100_000, maxIterations: 3, timeoutMs: 20_000 },
		resumeHandler: async () => ({ action: 'continue' as const }),
	}
}

async function recordTypes(killed: Killed): Promise<string[]> {
	const log = DiskSessionLog.at(killed.paths, { sessionId: killed.ids.sessionId })
	return (await log.readAll()).entries.map((entry) => entry.record.type)
}

describe('a turn whose process was killed', () => {
	it('refuses a new turn on the session, naming the turn as interrupted', async () => {
		const killed = await killedTurn()
		const provider = new MockLLMProvider({ turns: [{ text: 'fresh' }] })

		const refusal = await drainQuery({
			...params(killed, provider),
			messages: [createUserMessage('start over')],
		}).catch((error: unknown) => error)

		expect(refusal).toBeInstanceOf(TurnInProgressError)
		expect(refusal).toMatchObject({ activeTurnId: killed.ids.turnId, state: 'interrupted' })
		expect(provider.requests).toHaveLength(0)
	}, 60_000)

	it('closes the dead turn first when the new one asks to abandon it', async () => {
		const killed = await killedTurn()
		const provider = new MockLLMProvider({ turns: [{ text: 'fresh start' }] })

		const turn = await drainQuery({
			...params(killed, provider),
			abandonInterrupted: true,
			messages: [createUserMessage('start over')],
		})

		expect(turn.status).toBe('completed')
		expect(turn.id).not.toBe(killed.ids.turnId)
		const log = DiskSessionLog.at(killed.paths, { sessionId: killed.ids.sessionId })
		const failed = (await log.readAll()).entries
			.map(
				(entry) => entry.record as { type: string; turnId?: string; failure?: { code?: string } },
			)
			.find((record) => record.type === 'turn_failed')
		expect(failed).toMatchObject({ turnId: killed.ids.turnId, failure: { code: 'interrupted' } })
	}, 60_000)

	it('does not duplicate a tool call across an abandon and a further live send', async () => {
		// The exact shape this reproduces: turn 1 dies mid tool call (a real
		// SIGKILL, so its result is synthesized as an interruption, never a
		// durable one). Turn 2 abandons it and makes its OWN tool call. A
		// third, live send in the SAME process then reuses turn 2's own
		// settled `messages` (carrying the ids `TurnRecorder` stamped onto
		// them) exactly as a host is told it may. Neither the dead turn's
		// tool call nor turn 2's own may appear twice.
		const killed = await killedTurn()
		const echoTools = new ToolRegistry()
		echoTools.register({
			name: 'echo',
			description: 'echo',
			inputSchema: z.object({}),
			execute: async () => ({ success: true, output: 'ok' }),
		})
		const turn2 = await drainQuery({
			...params(
				killed,
				new MockLLMProvider({
					turns: [
						{ toolCalls: [{ id: 'turn2-echo', name: 'echo', args: {} }] },
						{ text: 'turn two reply' },
					],
				}),
			),
			tools: echoTools,
			abandonInterrupted: true,
			messages: [createUserMessage('continue after the crash')],
		})
		expect(turn2.status).toBe('completed')

		const turn3 = await drainQuery({
			...params(killed, new MockLLMProvider({ responseText: 'turn three reply' })),
			messages: [...turn2.messages, createUserMessage('third message')],
		})

		expect(turn3.status).toBe('completed')
		const toolCallIds = turn3.messages
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? [])
		expect(toolCallIds.filter((id) => id === 'turn2-echo')).toHaveLength(1)
		expect(toolCallIds.filter((id) => id === 'c1')).toHaveLength(1)
	}, 60_000)

	it('continues the same turn when it is resumed from its checkpoint', async () => {
		const killed = await killedTurn()
		const provider = new MockLLMProvider({ turns: [{ text: 'picked up where it stopped' }] })
		// What a host in a new process opens: the log, by the same paths. The
		// checkpoints are found beside it.
		const outcome = await resumeSession({
			...params(killed, provider),
			scope: killed.ids,
			sessionLog: DiskSessionLog.at(killed.paths, { sessionId: killed.ids.sessionId }),
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.turn.id).toBe(killed.ids.turnId)
		expect(outcome.turn.status).toBe('completed')
		const types = await recordTypes(killed)
		expect(types.filter((type) => type === 'turn_started')).toHaveLength(1)
		expect(types).toContain('turn_resuming')
		expect(types.at(-1)).toBe('turn_completed')
	}, 60_000)
})
