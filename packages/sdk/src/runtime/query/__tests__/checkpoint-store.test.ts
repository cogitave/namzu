import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type {
	CheckpointId,
	HITLDecisionRequest,
	IterationCheckpoint,
} from '../../../types/hitl/index.js'
import type { TurnId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/session/durable.js'
import type { SessionEvent } from '../../../types/session/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { CheckpointManager } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { runIterationCheckpoint } from '../iteration/phases/checkpoint.js'
import type { IterationContext } from '../iteration/phases/context.js'

const ZERO_COST = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
	unpricedTokens: 0,
}

const SCOPE: CheckpointRunScope = {
	tenantId: 'abe9b1f4-58f3-4617-9092-e3c3eddf7fa8' as TenantId,
	projectId: '6b5fe163-dd2f-47ac-a34b-7f4c61e3d111' as ProjectId,
	sessionId: '63a68db5-e762-413a-aebc-6edc4b1d61f2' as SessionId,
	turnId: '828316da-a45c-4d83-98f7-7b6a534df23b' as TurnId,
}

/**
 * In-memory {@link CheckpointStore} used both as the conformance fixture for
 * `CheckpointManager` and as the injected store in the query()-level test.
 * Keys rows by the full scope so the tests can assert the kernel passes the
 * five-layer attribution through, not just the checkpoint payload.
 */
class InMemoryCheckpointStore implements CheckpointStore {
	readonly rows = new Map<string, IterationCheckpoint>()
	readonly seenScopes: CheckpointRunScope[] = []

	private key(scope: CheckpointRunScope, checkpointId: CheckpointId): string {
		return [scope.tenantId, scope.projectId, scope.sessionId, scope.runId, checkpointId].join('/')
	}

	private runPrefix(scope: CheckpointRunScope): string {
		return `${[scope.tenantId, scope.projectId, scope.sessionId, scope.runId].join('/')}/`
	}

	async writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void> {
		this.seenScopes.push(scope)
		this.rows.set(this.key(scope, checkpoint.id), checkpoint)
	}

	async readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null> {
		return this.rows.get(this.key(scope, checkpointId)) ?? null
	}

	async listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]> {
		const prefix = this.runPrefix(scope)
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, cp]) => cp)
			.sort((a, b) => a.createdAt - b.createdAt)
	}

	async deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void> {
		this.rows.delete(this.key(scope, checkpointId))
	}
}

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

function makeRunMgrStub(): TurnRecorder {
	return {
		id: SCOPE.runId,
		messages: [{ role: 'user', content: 'hello' }],
		tokenUsage: { ...ZERO_USAGE },
		costInfo: { ...ZERO_COST },
		currentIteration: 1,
		getSession: () => ({ startedAt: Date.now() }),
	} as unknown as TurnRecorder
}

describe('CheckpointManager against an injected CheckpointStore', () => {
	it('round-trips create → restore → list → prune through the interface', async () => {
		const store = new InMemoryCheckpointStore()
		const mgr = new CheckpointManager(store, SCOPE)
		const recorder = makeRunMgrStub()

		const first = await mgr.create(recorder, 1)
		const second = await mgr.create(recorder, 2)
		// Deterministic ordering for prune (createdAt can tie at ms resolution).
		const storedFirst = store.rows.get(
			[SCOPE.tenantId, SCOPE.projectId, SCOPE.sessionId, SCOPE.runId, first.id].join('/'),
		)
		const storedSecond = store.rows.get(
			[SCOPE.tenantId, SCOPE.projectId, SCOPE.sessionId, SCOPE.runId, second.id].join('/'),
		)
		if (storedFirst) storedFirst.createdAt = 1_000
		if (storedSecond) storedSecond.createdAt = 2_000

		// restore reads back through the interface
		const restored = await mgr.restore(first.id)
		expect(restored.id).toBe(first.id)
		expect(restored.iteration).toBe(1)

		// list sees both, oldest first
		const listed = await mgr.list()
		expect(listed.map((cp) => cp.id)).toEqual([first.id, second.id])

		// prune deletes oldest-first through deleteCheckpoint
		await mgr.prune(1)
		const remaining = await mgr.list()
		expect(remaining.map((cp) => cp.id)).toEqual([second.id])

		// every write carried the full five-layer scope
		expect(store.seenScopes.every((s) => s.tenantId === SCOPE.tenantId)).toBe(true)
		expect(store.seenScopes.every((s) => s.sessionId === SCOPE.sessionId)).toBe(true)
	})

	it('restore throws a descriptive error for a missing checkpoint', async () => {
		const mgr = new CheckpointManager(new InMemoryCheckpointStore(), SCOPE)
		await expect(
			mgr.restore('e8e27c68-a53c-4003-9fbe-3349649af71a' as CheckpointId),
		).rejects.toThrow('Checkpoint not found: e8e27c68-a53c-4003-9fbe-3349649af71a')
	})
})

// ─── cadence + prune via the iteration-checkpoint phase ──────────────────────

function makePhaseContext(
	store: InMemoryCheckpointStore,
	turnConfig: { checkpointEvery?: number; pruneKeepLast?: number },
): { ctx: IterationContext; events: SessionEvent[] } {
	const events: SessionEvent[] = []
	const ctx = {
		turnConfig: {
			model: 'mock-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			...turnConfig,
		},
		recorder: makeRunMgrStub(),
		checkpointMgr: new CheckpointManager(store, SCOPE),
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
		drainPending: function* (): Generator<SessionEvent> {},
		resumeHandler: async () => ({ action: 'continue' as const }),
	} as unknown as IterationContext
	return { ctx, events }
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
		const store = new InMemoryCheckpointStore()
		const { ctx, events } = makePhaseContext(store, {})

		await drivePhase(ctx, 1)
		await drivePhase(ctx, 2)
		await drivePhase(ctx, 3)

		expect(store.rows.size).toBe(3)
		expect(events.filter((e) => e.type === 'checkpoint_created')).toHaveLength(3)
	})

	it('checkpointEvery: 2 checkpoints iterations 1, 3, 5 and skips the rest', async () => {
		const store = new InMemoryCheckpointStore()
		const { ctx, events } = makePhaseContext(store, { checkpointEvery: 2 })

		for (const iteration of [1, 2, 3, 4, 5]) {
			await drivePhase(ctx, iteration)
		}

		const created = events.filter(
			(e): e is Extract<SessionEvent, { type: 'checkpoint_created' }> =>
				e.type === 'checkpoint_created',
		)
		expect(created.map((e) => e.iteration)).toEqual([1, 3, 5])
		expect(store.rows.size).toBe(3)
	})

	it('pruneKeepLast keeps only the newest N checkpoints after each create', async () => {
		const store = new InMemoryCheckpointStore()
		const { ctx } = makePhaseContext(store, { pruneKeepLast: 2 })

		// Make createdAt strictly increasing so prune order is deterministic.
		let tick = 0
		const originalWrite = store.writeCheckpoint.bind(store)
		store.writeCheckpoint = async (scope, checkpoint) => {
			tick += 1
			await originalWrite(scope, { ...checkpoint, createdAt: tick })
		}

		await drivePhase(ctx, 1)
		await drivePhase(ctx, 2)
		await drivePhase(ctx, 3)
		await drivePhase(ctx, 4)

		const remaining = await store.listCheckpoints(SCOPE)
		expect(remaining).toHaveLength(2)
		expect(remaining.map((cp) => cp.iteration)).toEqual([3, 4])
	})
})

// ─── query()-level injection ─────────────────────────────────────────────────

describe('query() with an injected checkpointStore', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('persists iteration checkpoints into the injected store, keyed by run scope', async () => {
		// One tool call, then a closing text turn.
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
		})
		const store = new InMemoryCheckpointStore()
		const tools = new ToolRegistry()
		tools.register({
			name: 'echo',
			description: 'echo the text back',
			inputSchema: z.object({ text: z.string() }),
			execute: async () => ({ success: true, output: 'hi' }),
		})

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-store-'))
		workdirs.push(workingDirectory)

		const run = await drainQuery({
			provider,
			tools,
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
			sessionId: 'e30ed68d-7637-45a7-80ee-90a3ec4cb97d' as SessionId,
			topicId: '76a408c2-931a-47a2-b87a-f842af1fe66b' as TopicId,
			projectId: 'b2e4b0a3-6a77-4b00-82d6-9125bf4abc4e' as ProjectId,
			tenantId: 'b5da353d-5241-402d-8de9-48f203031c19' as TenantId,
		})

		expect(run.status).toBe('completed')
		// The tool-call iteration produced at least one checkpoint, and it
		// landed in the injected store — not on disk.
		expect(store.rows.size).toBeGreaterThan(0)
		const scope = store.seenScopes[0]
		expect(scope?.tenantId).toBe('b5da353d-5241-402d-8de9-48f203031c19')
		expect(scope?.projectId).toBe('b2e4b0a3-6a77-4b00-82d6-9125bf4abc4e')
		expect(scope?.sessionId).toBe('e30ed68d-7637-45a7-80ee-90a3ec4cb97d')
		expect(scope?.runId).toBe(run.id)
	})
})

// ─── prune() against an outstanding park ─────────────────────────────────────

/**
 * `prune` collects oldest-first by `createdAt` and asked nothing about
 * `pending`. `findPendingCheckpoint` and `listExpiredParks` in the same file
 * treat a checkpoint with an unresolved park as the thing a host is waiting
 * on, and both cannot be right: the row an approval queue is about to serve
 * must not be collected as growth control.
 */

/** `createdAt` is `Date.now()`, so prune's order would tie at ms resolution. */
function monotonicallyStamped(store: InMemoryCheckpointStore): InMemoryCheckpointStore {
	let tick = 0
	const originalWrite = store.writeCheckpoint.bind(store)
	store.writeCheckpoint = async (scope, checkpoint) => {
		const existing = await store.readCheckpoint(scope, checkpoint.id)
		if (existing) {
			// A rewrite — a park, an unpark, an expiry — keeps the checkpoint's
			// own creation instant, which is what the real stores do: only
			// `pending` changes. Stamping it here would make an expiry look
			// like a fresh checkpoint and reorder the prune.
			await originalWrite(scope, { ...checkpoint, createdAt: existing.createdAt })
			return
		}
		tick += 1
		await originalWrite(scope, { ...checkpoint, createdAt: tick })
	}
	return store
}

function parkRequest(checkpointId: CheckpointId): HITLDecisionRequest {
	return { type: 'tool_review', runId: SCOPE.runId, checkpointId, toolCalls: [] }
}

describe('prune() and an outstanding park', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('keeps the checkpoint a host is still waiting on', async () => {
		const store = monotonicallyStamped(new InMemoryCheckpointStore())
		const mgr = new CheckpointManager(store, SCOPE)

		const parked = await mgr.create(makeRunMgrStub(), 1)
		await mgr.park(parked, parkRequest(parked.id))
		const newer = await mgr.create(makeRunMgrStub(), 2)

		// keepLast 1: the parked checkpoint is the oldest, so it is the first
		// thing an unconditional oldest-first prune collects.
		await mgr.prune(1)

		expect((await mgr.list()).map((cp) => cp.id)).toEqual([parked.id, newer.id])
		expect((await mgr.findPending())?.id).toBe(parked.id)
	})

	it('collects that same checkpoint once the park is resolved', async () => {
		const store = monotonicallyStamped(new InMemoryCheckpointStore())
		const mgr = new CheckpointManager(store, SCOPE)

		const parked = await mgr.create(makeRunMgrStub(), 1)
		await mgr.park(parked, parkRequest(parked.id))
		await mgr.unpark(parked.id, { action: 'approve_tools' })
		const newer = await mgr.create(makeRunMgrStub(), 2)

		await mgr.prune(1)

		// Skipping a park is not a licence to keep every checkpoint forever:
		// once nobody is waiting on it, it ages out like any other.
		expect((await mgr.list()).map((cp) => cp.id)).toEqual([newer.id])
	})

	it('collects it after an expiry sweep resolved it', async () => {
		const store = monotonicallyStamped(new InMemoryCheckpointStore())
		const mgr = new CheckpointManager(store, SCOPE)

		const parked = await mgr.create(makeRunMgrStub(), 1)
		// A deadline in the past: the park is expired the moment it is written.
		await mgr.park(parked, parkRequest(parked.id), { ttlMs: 1 })
		const newer = await mgr.create(makeRunMgrStub(), 2)

		// An expired park is not one a queue serves, and a host sweeps it with
		// `expire` rather than by pruning. Until it does, the row stands.
		await mgr.prune(1)
		expect((await mgr.list()).map((cp) => cp.id)).toContain(parked.id)

		await mgr.expire(parked.id)
		await mgr.prune(1)
		expect((await mgr.list()).map((cp) => cp.id)).toEqual([newer.id])
	})

	it('does not collect one a run pruned over', async () => {
		// The reachable shape: a checkpoint parked for a human, left
		// outstanding by a session that ended, and a run resumed under the
		// same id that prunes as it goes. There is no `pendingDecision`, so
		// nothing unparks it — `query` only clears a park it applies.
		const store = monotonicallyStamped(new InMemoryCheckpointStore())
		const mgr = new CheckpointManager(store, SCOPE)
		const planted = await mgr.create(makeRunMgrStub(), 1)
		await mgr.park(planted, parkRequest(planted.id))

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-checkpoint-park-'))
		workdirs.push(workingDirectory)

		const tools = new ToolRegistry()
		tools.register({
			name: 'echo',
			description: 'echo the text back',
			inputSchema: z.object({ text: z.string() }),
			execute: async () => ({ success: true, output: 'hi' }),
		})

		await drainQuery({
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'done' }],
			}),
			tools,
			checkpointStore: store,
			turnId: SCOPE.runId,
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				pruneKeepLast: 1,
			},
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('use the echo tool')],
			workingDirectory,
			sessionId: SCOPE.sessionId,
			topicId: '76a408c2-931a-47a2-b87a-f842af1fe66b' as TopicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
		})

		// The run pruned — it wrote checkpoints and asked for keepLast 1, so
		// the planted row was a deletion candidate on `createdAt` alone.
		expect(store.seenScopes.some((scope) => scope.runId === SCOPE.runId)).toBe(true)
		expect((await mgr.findPending())?.id).toBe(planted.id)
	})
})
