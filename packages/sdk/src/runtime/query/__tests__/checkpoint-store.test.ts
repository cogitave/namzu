import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import {
	type CheckpointScope,
	type CheckpointWriteReceipt,
	InMemorySessionCheckpointStore,
} from '../../../store/checkpoint/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { Toolset } from '../../../toolsets/types.js'
import type { CheckpointId, HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { CheckpointManager } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { runIterationCheckpoint } from '../iteration/phases/checkpoint.js'
import type { IterationContext } from '../iteration/phases/context.js'
import { checkpointLogView } from '../session-storage.js'
import {
	type CheckpointedSession,
	TEST_SCOPE,
	checkpointRecords,
	sessionWithCheckpoint,
} from './support/session.js'

/**
 * The session's checkpoint store, recording the scope of every write so the
 * tests can assert the kernel passes the whole attribution through, not
 * just the document.
 */
class RecordingCheckpointStore extends InMemorySessionCheckpointStore {
	readonly seenScopes: CheckpointScope[] = []

	override async write(
		scope: CheckpointScope,
		checkpoint: Checkpoint,
	): Promise<CheckpointWriteReceipt> {
		this.seenScopes.push(scope)
		return super.write(scope, checkpoint)
	}
}

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** The recorder side `create` reads: the turn's usage and the log's head. */
function recorderOf(session: CheckpointedSession): never {
	return {
		...checkpointRecords(session),
		messages: [{ role: 'user', content: 'hello' }],
		tokenUsage: { ...ZERO_USAGE },
		costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
		currentIteration: 1,
		getTurn: () => ({ startedAt: Date.now() }),
		head: () => session.log.head(),
		recordedIdOf: () => undefined,
	} as never
}

/** An open turn with a fresh recording store beside its log, and a manager over both. */
async function managed() {
	const session = await sessionWithCheckpoint()
	const store = new RecordingCheckpointStore({ log: checkpointLogView(session.log) })
	const mgr = new CheckpointManager(checkpointRecords(session), store, session.scope)
	return { session, store, mgr, recorder: recorderOf(session) }
}

describe('CheckpointManager against an injected checkpoint store', () => {
	it('round-trips create → restore → list → prune through the interface', async () => {
		const { session, store, mgr, recorder } = await managed()

		const first = await mgr.create(recorder, 1)
		const second = await mgr.create(recorder, 2)

		// restore reads back through the interface
		const restored = await mgr.restore(first.id)
		expect(restored.id).toBe(first.id)
		expect(restored.document.iteration).toBe(1)

		// list sees both, oldest first
		const listed = await mgr.list()
		expect(listed.map((cp) => cp.checkpointId)).toEqual([first.id, second.id])

		// prune collects oldest-first, and says so in the log
		await mgr.prune(1)
		const remaining = await mgr.list()
		expect(remaining.map((cp) => cp.checkpointId)).toEqual([second.id])
		const pruned = (await session.log.readAll()).entries
			.map((entry) => entry.record)
			.filter((record) => record.type === 'checkpoint_pruned')
		expect(pruned).toHaveLength(1)

		// every write carried the full attribution
		expect(store.seenScopes.every((s) => s.tenantId === session.scope.tenantId)).toBe(true)
		expect(store.seenScopes.every((s) => s.sessionId === session.scope.sessionId)).toBe(true)
		expect(store.seenScopes.every((s) => s.turnId === session.scope.turnId)).toBe(true)
	})

	it('restore throws a descriptive error for a missing checkpoint', async () => {
		const { mgr } = await managed()
		await expect(
			mgr.restore('e8e27c68-a53c-4003-9fbe-3349649af71a' as CheckpointId),
		).rejects.toThrow('Checkpoint not found: e8e27c68-a53c-4003-9fbe-3349649af71a')
	})
})

// ─── cadence + prune via the iteration-checkpoint phase ──────────────────────

async function makePhaseContext(turnConfig: {
	checkpointEvery?: number
	pruneKeepLast?: number
}): Promise<{ ctx: IterationContext; events: SessionEvent[]; store: RecordingCheckpointStore }> {
	const { store, mgr, recorder } = await managed()
	const events: SessionEvent[] = []
	const ctx = {
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			...turnConfig,
		},
		recorder,
		checkpointMgr: mgr,
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
		drainPending: function* (): Generator<SessionEvent> {},
		resumeHandler: async () => ({ action: 'continue' as const }),
	} as unknown as IterationContext
	return { ctx, events, store }
}

async function drivePhase(ctx: IterationContext, iterationNum: number): Promise<void> {
	const gen = runIterationCheckpoint(ctx, iterationNum)
	let result = await gen.next()
	while (!result.done) {
		result = await gen.next()
	}
}

describe('iteration checkpoint cadence (checkpointEvery)', () => {
	it('defaults to a checkpoint on every iteration', async () => {
		const { ctx, events, store } = await makePhaseContext({})

		await drivePhase(ctx, 1)
		await drivePhase(ctx, 2)
		await drivePhase(ctx, 3)

		expect(store.seenScopes).toHaveLength(3)
		expect(events.filter((e) => e.type === 'checkpoint_created')).toHaveLength(3)
	})

	it('checkpointEvery: 2 checkpoints iterations 1, 3, 5 and skips the rest', async () => {
		const { ctx, events, store } = await makePhaseContext({ checkpointEvery: 2 })

		for (const iteration of [1, 2, 3, 4, 5]) {
			await drivePhase(ctx, iteration)
		}

		const created = events.filter(
			(e): e is Extract<SessionEvent, { type: 'checkpoint_created' }> =>
				e.type === 'checkpoint_created',
		)
		expect(created.map((e) => e.iteration)).toEqual([1, 3, 5])
		expect(store.seenScopes).toHaveLength(3)
	})

	it('pruneKeepLast keeps only the newest N checkpoints after each create', async () => {
		const { ctx, store } = await makePhaseContext({ pruneKeepLast: 2 })

		await drivePhase(ctx, 1)
		await drivePhase(ctx, 2)
		await drivePhase(ctx, 3)
		await drivePhase(ctx, 4)

		const scope = store.seenScopes[0] as CheckpointScope
		const remaining = await store.list(scope)
		expect(remaining).toHaveLength(2)
		expect(remaining.map((cp) => cp.iteration)).toEqual([3, 4])
	})
})

// ─── query()-level injection ─────────────────────────────────────────────────

function echoTools(): Toolset {
	return testToolset({
		name: 'echo',
		description: 'echo the text back',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'hi' }),
	})
}

describe('query() with an injected checkpoint store', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('persists iteration checkpoints into the injected store, keyed by turn scope', async () => {
		// One tool call, then a closing text turn.
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
		})
		const sessionId = 'e30ed68d-7637-45a7-80ee-90a3ec4cb97d' as SessionId
		const sessionLog = new InMemorySessionLog({ sessionId })
		const store = new RecordingCheckpointStore({ log: checkpointLogView(sessionLog) })

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-store-'))
		workdirs.push(workingDirectory)

		const turn = await drainQuery({
			provider,
			toolsets: [echoTools()],
			sessionLog,
			checkpointStore: store,
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('use the echo tool')],
			workingDirectory,
			sessionId,
			topicId: '76a408c2-931a-47a2-b87a-f842af1fe66b' as TopicId,
			projectId: 'b2e4b0a3-6a77-4b00-82d6-9125bf4abc4e' as ProjectId,
			tenantId: 'b5da353d-5241-402d-8de9-48f203031c19' as TenantId,
		})

		expect(turn.status).toBe('completed')
		// The tool-call iteration produced at least one checkpoint, and it
		// landed in the injected store.
		expect(store.seenScopes.length).toBeGreaterThan(0)
		const scope = store.seenScopes[0]
		expect(scope?.tenantId).toBe('b5da353d-5241-402d-8de9-48f203031c19')
		expect(scope?.projectId).toBe('b2e4b0a3-6a77-4b00-82d6-9125bf4abc4e')
		expect(scope?.sessionId).toBe(sessionId)
		expect(scope?.turnId).toBe(turn.id)
	})
})

// ─── prune() against an outstanding park ─────────────────────────────────────

/**
 * Prune collects oldest-first by `createdAt`. A checkpoint an open decision
 * references is the thing a host is waiting on, and the row an approval queue
 * is about to serve must not be collected as growth control.
 */

function parkRequest(
	session: CheckpointedSession,
	checkpointId: CheckpointId,
): HITLDecisionRequest {
	return {
		type: 'tool_review',
		sessionId: session.sessionId,
		turnId: session.turnId,
		checkpointId,
		toolCalls: [],
	} as unknown as HITLDecisionRequest
}

describe('prune() and an outstanding park', () => {
	it('keeps the checkpoint a host is still waiting on', async () => {
		const { session, mgr, recorder } = await managed()

		const parked = await mgr.create(recorder, 1)
		await mgr.park(parked, parkRequest(session, parked.id))
		const newer = await mgr.create(recorder, 2)

		// keepLast 1: the parked checkpoint is the oldest, so it is the first
		// thing an unconditional oldest-first prune collects.
		await mgr.prune(1)

		expect((await mgr.list()).map((cp) => cp.checkpointId)).toEqual([parked.id, newer.id])
		expect((await mgr.findPending())?.checkpointId).toBe(parked.id)
	})

	it('collects that same checkpoint once the park is resolved', async () => {
		const { session, mgr, recorder } = await managed()

		const parked = await mgr.create(recorder, 1)
		await mgr.park(parked, parkRequest(session, parked.id))
		await mgr.unpark(parked.id, { action: 'approve_tools' })
		const newer = await mgr.create(recorder, 2)

		await mgr.prune(1)

		// Skipping a park is not a licence to keep every checkpoint forever:
		// once nobody is waiting on it, it ages out like any other.
		expect((await mgr.list()).map((cp) => cp.checkpointId)).toEqual([newer.id])
	})

	it('collects it after an expiry sweep resolved it', async () => {
		const { session, mgr, recorder } = await managed()

		const parked = await mgr.create(recorder, 1)
		// A deadline in the past: the park is expired the moment it is written.
		await mgr.park(parked, parkRequest(session, parked.id), { ttlMs: 1 })
		const newer = await mgr.create(recorder, 2)
		await new Promise((resolve) => setTimeout(resolve, 5))

		// An expired park is not one a queue serves, and a host sweeps it with
		// `expire` rather than by pruning. Until it does, the row stands.
		await mgr.prune(1)
		expect((await mgr.list()).map((cp) => cp.checkpointId)).toContain(parked.id)

		await mgr.expire(parked.id)
		await mgr.prune(1)
		expect((await mgr.list()).map((cp) => cp.checkpointId)).toEqual([newer.id])
	})

	it('does not collect one a turn pruned over', async () => {
		// The reachable shape: a checkpoint parked for a human and left
		// outstanding, and the same turn resumed without the answer, pruning
		// as it goes. There is no `pendingDecision`, so nothing unparks it —
		// `query` only clears a park it applies.
		const { session, store, mgr, recorder } = await managed()
		const planted = await mgr.create(recorder, 1)
		await mgr.park(planted, parkRequest(session, planted.id))
		await session.log.release(session.lease)

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-park-'))
		try {
			await drainQuery({
				provider: new MockLLMProvider({
					turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
				}),
				toolsets: [echoTools()],
				sessionLog: session.log,
				checkpointStore: store,
				turnId: session.turnId,
				resumeFromCheckpoint: planted.id,
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 3,
					pruneKeepLast: 1,
				},
				agentId: 'agent_test',
				agentName: 'Test Agent',
				messages: [],
				workingDirectory,
				sessionId: session.sessionId,
				topicId: TEST_SCOPE.topicId,
				projectId: TEST_SCOPE.projectId,
				tenantId: TEST_SCOPE.tenantId,
				resumeHandler: async () => ({ action: 'continue' }),
			})
		} finally {
			await removeTempDirs([workingDirectory])
		}

		// The turn pruned — it wrote checkpoints and asked for keepLast 1, so
		// the planted row was a deletion candidate on `createdAt` alone.
		expect(store.seenScopes.length).toBeGreaterThan(1)
		expect((await mgr.list()).map((cp) => cp.checkpointId)).toContain(planted.id)
	})
})
