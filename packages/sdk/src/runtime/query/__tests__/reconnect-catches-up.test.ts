import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEventReplay } from '../../../types/run/event-cursor.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { QueryParams } from '../index.js'
import { query } from '../index.js'
import { resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

/**
 * "Refresh the page and keep watching the answer arrive."
 *
 * The consumer is watching a run, the process holding it dies, and the
 * consumer comes back. It must receive every non-ephemeral event it missed,
 * exactly once, in order — or be told, in a value it cannot ignore, that it
 * cannot have them.
 *
 * These drive `resumeRun`, which is the call a host makes to continue a run a
 * different process started. Entering at `query` instead would prove the
 * catch-up and not the road to it: `resumeRun` drained the run with NO listener
 * at all until this change, so every event it produced was discarded, and a
 * catch-up delivered into that reaches nobody.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const SCOPE: RunStateScope = {
	tenantId: 'tnt_re' as TenantId,
	projectId: 'prj_re' as ProjectId,
	sessionId: 'ses_re' as SessionId,
	runId: 'run_re' as RunId,
	topicId: 'top_re' as ThreadId,
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

/**
 * A run's evidence on a real filesystem, shared between the two halves of the
 * test.
 *
 * The disk store is what actually crosses a process boundary here: the object
 * graph of the second half is entirely new, and the only thing carried over is
 * the directory. An in-memory store would prove the same code with none of the
 * property.
 */
function diskStore(baseDir: string): RunDiskStore {
	return new RunDiskStore({ baseDir: join(baseDir, 'runs'), logger: LOG })
}

async function resumeParams(baseDir: string, checkpointStore: InMemoryCheckpointStore) {
	return {
		scope: SCOPE,
		checkpointStore,
		provider: new MockLLMProvider({ turns: [{ text: 'continued' }] }),
		tools: registryWithEcho(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			maxResponseTokens: 256,
		},
		agentId: 'agent_re',
		agentName: 'Reconnect Agent',
		workingDirectory: baseDir,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		// A NEW store object over the SAME directory: what the second process
		// builds.
		runStore: diskStore(baseDir),
		resumeHandler: async () => ({ action: 'continue' as const }),
	}
}

/**
 * Run once, capturing both the events a consumer saw and the checkpoints the
 * run left behind, so the second half can pick it up.
 */
async function crashedRun(): Promise<{
	baseDir: string
	seen: RunEvent[]
	checkpointStore: InMemoryCheckpointStore
}> {
	const baseDir = await workdir()
	const checkpointStore = new InMemoryCheckpointStore()
	const seen: RunEvent[] = []
	const gen = query({
		messages: [createUserMessage('go')],
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
		}),
		tools: registryWithEcho(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_re',
		agentName: 'Reconnect Agent',
		workingDirectory: baseDir,
		runId: SCOPE.runId,
		sessionId: SCOPE.sessionId,
		topicId: SCOPE.topicId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		runStore: diskStore(baseDir),
		checkpointStore,
		resumeHandler: async () => ({ action: 'continue' as const }),
	} as unknown as QueryParams)

	let next = await gen.next()
	while (!next.done) {
		seen.push(next.value)
		next = await gen.next()
	}
	return { baseDir, seen, checkpointStore }
}

describe('a consumer that lost its connection', () => {
	it('receives every event above its cursor, once, in order, from a new process', async () => {
		const { baseDir, seen, checkpointStore } = await crashedRun()
		const recorded = seen.filter((e) => e.seq !== undefined)
		expect(recorded.length).toBeGreaterThan(4)
		// It stopped watching a third of the way through.
		const cursor = recorded[1]?.seq as number

		const received: RunEvent[] = []
		const outcome = await resumeRun({
			...(await resumeParams(baseDir, checkpointStore)),
			eventCursor: { sinceSeq: cursor },
			listener: (event: RunEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.replay?.status).toBe('replayed')

		const numbered = received.filter((e) => e.seq !== undefined).map((e) => e.seq as number)
		// Nothing below the cursor, nothing repeated, nothing skipped — and the
		// resumed run's own events continue the same sequence rather than
		// restarting inside it.
		expect(numbered[0]).toBe(cursor + 1)
		expect(new Set(numbered).size).toBe(numbered.length)
		expect(numbered).toEqual(numbered.map((_, i) => cursor + 1 + i))
		expect(numbered.length).toBeGreaterThan(recorded.length - cursor)
	})

	it('is handed the missed events BEFORE the resumed run says anything new', async () => {
		const { baseDir, seen, checkpointStore } = await crashedRun()
		const recorded = seen.filter((e) => e.seq !== undefined)
		const cursor = recorded[1]?.seq as number
		const lastRecordedSeq = recorded.at(-1)?.seq as number

		const received: RunEvent[] = []
		await resumeRun({
			...(await resumeParams(baseDir, checkpointStore)),
			eventCursor: { sinceSeq: cursor },
			listener: (event: RunEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		// Any other order and a consumer cannot fold one stream into one state:
		// it would apply the run's new events and then be handed the run's past
		// on top of them.
		const firstNewIndex = received.findIndex((e) => (e.seq ?? 0) > lastRecordedSeq)
		const lastOldIndex = received.reduce(
			(acc, e, i) => (e.seq !== undefined && e.seq <= lastRecordedSeq ? i : acc),
			-1,
		)
		expect(firstNewIndex).toBeGreaterThan(lastOldIndex)
	})

	it('reports complete, and replays nothing, for a cursor already at the head', async () => {
		const { baseDir, seen, checkpointStore } = await crashedRun()
		const head = seen.filter((e) => e.seq !== undefined).at(-1)?.seq as number

		const received: RunEvent[] = []
		const outcome = await resumeRun({
			...(await resumeParams(baseDir, checkpointStore)),
			eventCursor: { sinceSeq: head },
			listener: (event: RunEvent) => {
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

describe('it refuses a cursor it cannot honour, and still resumes the run', () => {
	it('calls a cursor above the log ahead, hands over nothing, and runs anyway', async () => {
		const { baseDir, checkpointStore } = await crashedRun()

		let replay: RunEventReplay | undefined
		const received: RunEvent[] = []
		const outcome = await resumeRun({
			...(await resumeParams(baseDir, checkpointStore)),
			eventCursor: { sinceSeq: 10_000 },
			onEventReplay: (verdict: RunEventReplay) => {
				replay = verdict
			},
			listener: (event: RunEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(replay).toEqual({ status: 'unavailable', reason: 'cursor_ahead' })
		// The run was not held hostage to a client's bad cursor.
		expect(outcome.resumed).toBe(true)
		expect(received.some((e) => e.seq !== undefined)).toBe(true)
	})

	it('refuses a cursor from an older claim rather than splicing across it', async () => {
		const { baseDir, seen, checkpointStore } = await crashedRun()
		const recorded = seen.filter((e) => e.seq !== undefined)
		const cursor = recorded[1]?.seq as number
		const head = recorded.at(-1)?.seq as number

		let replay: RunEventReplay | undefined
		const received: RunEvent[] = []
		await resumeRun({
			...(await resumeParams(baseDir, checkpointStore)),
			// The run is taken over under a higher fence; the consumer's cursor
			// was minted under the lower one.
			claimFence: 9,
			eventCursor: { sinceSeq: cursor, generation: 4 },
			onEventReplay: (verdict: RunEventReplay) => {
				replay = verdict
			},
			listener: (event: RunEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		expect(replay).toEqual({ status: 'unavailable', reason: 'generation_changed' })
		// The assertion that carries the refusal: the log DOES hold events above
		// the cursor here, so a catch-up that ignored the verdict would deliver
		// them. Nothing at or below the old head may arrive — the resumed run
		// continues the sequence, so every legitimate event is above it.
		//
		// The first version of this test asserted `generation === undefined ||
		// generation === 9`, which the replayed events satisfy: the crashed run
		// was unclaimed, so its events carry no generation at all. It passed
		// against a build that spliced the whole gap in, and a mutation run is
		// what caught it.
		expect(head).toBeGreaterThan(cursor)
		expect(received.filter((e) => e.seq !== undefined && e.seq <= head)).toEqual([])
	})
})

describe('the listener is the hop', () => {
	it('delivers the resumed run’s own events, cursor or no cursor', async () => {
		const { baseDir, checkpointStore } = await crashedRun()

		const received: RunEvent[] = []
		await resumeRun({
			...(await resumeParams(baseDir, checkpointStore)),
			listener: (event: RunEvent) => {
				received.push(event)
			},
			// biome-ignore lint/suspicious/noExplicitAny: branded ids are not the subject.
		} as any)

		// Before this parameter existed `resumeRun` drained the run and dropped
		// every event it produced, so the one API for continuing a run another
		// process started could not show anybody what the run was doing.
		expect(received.length).toBeGreaterThan(0)
		expect(received.some((e) => e.type === 'run_completed')).toBe(true)
	})
})
