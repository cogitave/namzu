import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/events.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionLogReplay } from '../../../types/session/log-cursor.js'
import type { QueryParams } from '../index.js'
import { query } from '../index.js'
import { resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import { copySession, heldCheckpointStore } from './support/session.js'

/**
 * "Refresh the page and keep watching the answer arrive."
 *
 * The consumer is watching a turn, the process holding it dies, and the
 * consumer comes back. It must receive every non-ephemeral event it missed,
 * exactly once, in order — or be told, in a value it cannot ignore, that it
 * cannot have them.
 *
 * These drive `resumeSession`, which is the call a host makes to continue a turn a
 * different process started. Entering at `query` instead would prove the
 * catch-up and not the road to it: `resumeSession` drained the turn with NO listener
 * at all until this change, so every event it produced was discarded, and a
 * catch-up delivered into that reaches nobody.
 */

const SCOPE: TurnStateScope = {
	tenantId: 'f9a63b7d-293a-44dc-8437-c7aaa838030a' as TenantId,
	projectId: 'e1b45cba-6ba4-4344-b729-0e1ae32006c0' as ProjectId,
	sessionId: '5d7ae317-76ee-4da2-af79-58339cc3d4cd' as SessionId,
	turnId: 'fbc2d6ad-2dbb-479e-a1fe-6f5c93d92739' as TurnId,
	topicId: '0f20d062-dd85-4cc2-8a88-73846d81f64f' as TopicId,
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-reconnect-'))
	dirs.push(dir)
	return dir
}

function registryWithEcho(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'echo',
		description: 'echo the text back',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'hi' }),
	})
	return tools
}

async function resumeParams(crash: Crash) {
	return {
		scope: SCOPE,
		// What the second process opens: the log as the dead one left it.
		sessionLog: crash.log,
		checkpointStore: await heldCheckpointStore(crash.log),
		provider: new MockLLMProvider({ turns: [{ text: 'continued' }] }),
		tools: registryWithEcho(),
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			maxResponseTokens: 256,
		},
		agentId: 'agent_re',
		agentName: 'Reconnect Agent',
		workingDirectory: crash.baseDir,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		resumeHandler: async () => ({ action: 'continue' as const }),
	}
}

interface Crash {
	readonly baseDir: string
	/** The session log as it stood when the process died: a turn with a checkpoint and no verdict. */
	readonly log: InMemorySessionLog
	/** What the consumer had received by then. */
	readonly seen: SessionEvent[]
}

/**
 * A process that dies right after its first checkpoint: the consumer's view
 * up to then, and a copy of the log taken at that instant (what the disk
 * held). The original turn goes on in its own copy; the dead process's log
 * never hears of it, and reads back as an interrupted turn once the lease
 * is let go.
 */
async function crashedRun(): Promise<Crash> {
	const baseDir = await workdir()
	const sessionLog = new InMemorySessionLog({ sessionId: SCOPE.sessionId })
	const seen: SessionEvent[] = []
	let crashed: InMemorySessionLog | undefined
	const gen = query({
		messages: [createUserMessage('go')],
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
		}),
		tools: registryWithEcho(),
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_re',
		agentName: 'Reconnect Agent',
		workingDirectory: baseDir,
		turnId: SCOPE.turnId,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		sessionLog,
		resumeHandler: async () => ({ action: 'continue' as const }),
	} as unknown as QueryParams)

	for await (const event of gen) {
		if (crashed) continue
		seen.push(event)
		if (event.type === 'checkpoint_created') crashed = await copySession(sessionLog, [SCOPE])
	}
	if (!crashed) throw new Error('the turn wrote no checkpoint')
	return { baseDir, log: crashed, seen }
}

describe('a consumer that lost its connection', () => {
	it('receives every event above its cursor, once, in order, from a new process', async () => {
		const crash = await crashedRun()
		const { seen } = crash
		const recorded = seen.filter((e) => e.seq !== undefined)
		expect(recorded.length).toBeGreaterThan(4)
		// It stopped watching a third of the way through.
		const cursor = recorded[1]?.seq as number

		const received: SessionEvent[] = []
		const outcome = await resumeSession({
			...(await resumeParams(crash)),
			eventCursor: { sinceSeq: cursor },
			listener: (event: SessionEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.replay?.status).toBe('replayed')

		const numbered = received.filter((e) => e.seq !== undefined).map((e) => e.seq as number)
		// Nothing below the cursor, nothing repeated, nothing it missed left
		// out — and the resumed turn's own events continue the log's sequence
		// rather than restarting inside it. (An event's number is its record's
		// `seq`; message records sit between them, so the numbers have gaps.)
		const missed = recorded.map((e) => e.seq as number).filter((seq) => seq > cursor)
		expect(numbered[0]).toBeGreaterThan(cursor)
		expect(new Set(numbered).size).toBe(numbered.length)
		expect(numbered).toEqual([...numbered].sort((a, b) => a - b))
		expect(numbered).toEqual(expect.arrayContaining(missed))
		expect(numbered.length).toBeGreaterThan(missed.length)
	})

	it('is handed the missed events BEFORE the resumed turn says anything new', async () => {
		const crash = await crashedRun()
		const { seen } = crash
		const recorded = seen.filter((e) => e.seq !== undefined)
		const cursor = recorded[1]?.seq as number
		const lastRecordedSeq = recorded.at(-1)?.seq as number

		const received: SessionEvent[] = []
		await resumeSession({
			...(await resumeParams(crash)),
			eventCursor: { sinceSeq: cursor },
			listener: (event: SessionEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		// Any other order and a consumer cannot fold one stream into one state:
		// it would apply the turn's new events and then be handed the turn's past
		// on top of them.
		const firstNewIndex = received.findIndex((e) => (e.seq ?? 0) > lastRecordedSeq)
		const lastOldIndex = received.reduce(
			(acc, e, i) => (e.seq !== undefined && e.seq <= lastRecordedSeq ? i : acc),
			-1,
		)
		expect(firstNewIndex).toBeGreaterThan(lastOldIndex)
	})

	it('reports complete, and replays nothing, for a cursor already at the head', async () => {
		const crash = await crashedRun()
		const { seen } = crash
		const head = seen.filter((e) => e.seq !== undefined).at(-1)?.seq as number

		const received: SessionEvent[] = []
		const outcome = await resumeSession({
			...(await resumeParams(crash)),
			eventCursor: { sinceSeq: head },
			listener: (event: SessionEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.replay).toEqual({ status: 'complete' })
		// Everything delivered is genuinely new work, not the tail it already had.
		expect(received.every((e) => e.seq === undefined || e.seq > head)).toBe(true)
	})
})

describe('it refuses a cursor it cannot honour, and still resumes the turn', () => {
	it('calls a cursor above the log ahead, hands over nothing, and runs anyway', async () => {
		const crash = await crashedRun()

		let replay: SessionLogReplay | undefined
		const received: SessionEvent[] = []
		const outcome = await resumeSession({
			...(await resumeParams(crash)),
			eventCursor: { sinceSeq: 10_000 },
			onEventReplay: (verdict: SessionLogReplay) => {
				replay = verdict
			},
			listener: (event: SessionEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(replay).toEqual({ status: 'unavailable', reason: 'cursor_ahead' })
		// The turn was not held hostage to a client's bad cursor.
		expect(outcome.resumed).toBe(true)
		expect(received.some((e) => e.seq !== undefined)).toBe(true)
	})

	it('refuses a cursor from an older claim rather than splicing across it', async () => {
		const crash = await crashedRun()
		const { seen } = crash
		const recorded = seen.filter((e) => e.seq !== undefined)
		const cursor = recorded[1]?.seq as number
		const head = recorded.at(-1)?.seq as number

		let replay: SessionLogReplay | undefined
		const received: SessionEvent[] = []
		await resumeSession({
			...(await resumeParams(crash)),
			// The consumer's cursor was minted under a fence the log never had.
			eventCursor: { sinceSeq: cursor, generation: 4 },
			onEventReplay: (verdict: SessionLogReplay) => {
				replay = verdict
			},
			listener: (event: SessionEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(replay).toEqual({ status: 'unavailable', reason: 'generation_changed' })
		// The assertion that carries the refusal: the log DOES hold events above
		// the cursor here, so a catch-up that ignored the verdict would deliver
		// them. Nothing at or below the old head may arrive — the resumed turn
		// continues the sequence, so every legitimate event is above it.
		//
		// The first version of this test asserted on the replayed events'
		// generation, which they satisfied; it passed against a build that
		// spliced the whole gap in, and a mutation run is what caught it.
		expect(head).toBeGreaterThan(cursor)
		expect(received.filter((e) => e.seq !== undefined && e.seq <= head)).toEqual([])
	})
})

describe('the listener is the hop', () => {
	it('delivers the resumed turn’s own events, cursor or no cursor', async () => {
		const crash = await crashedRun()

		const received: SessionEvent[] = []
		await resumeSession({
			...(await resumeParams(crash)),
			listener: (event: SessionEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		// Before this parameter existed `resumeSession` drained the turn and dropped
		// every event it produced, so the one API for continuing a turn another
		// process started could not show anybody what the turn was doing.
		expect(received.length).toBeGreaterThan(0)
		expect(received.some((e) => e.type === 'turn_completed')).toBe(true)
	})
})
