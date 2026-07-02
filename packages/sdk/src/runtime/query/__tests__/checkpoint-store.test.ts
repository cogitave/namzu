import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { RunPersistence } from '../../../manager/run/persistence.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { CheckpointManager } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { runIterationCheckpoint } from '../iteration/phases/checkpoint.js'
import type { IterationContext } from '../iteration/phases/context.js'

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const ZERO_COST = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
}

const SCOPE: CheckpointRunScope = {
	tenantId: 'tnt_cp_store' as TenantId,
	projectId: 'prj_cp_store' as ProjectId,
	sessionId: 'ses_cp_store' as SessionId,
	runId: 'run_cp_store' as RunId,
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

function makeRunMgrStub(): RunPersistence {
	return {
		id: SCOPE.runId,
		messages: [{ role: 'user', content: 'hello' }],
		tokenUsage: { ...ZERO_USAGE },
		costInfo: { ...ZERO_COST },
		currentIteration: 1,
		getSession: () => ({ startedAt: Date.now() }),
	} as unknown as RunPersistence
}

describe('CheckpointManager against an injected CheckpointStore', () => {
	it('round-trips create → restore → list → prune through the interface', async () => {
		const store = new InMemoryCheckpointStore()
		const mgr = new CheckpointManager(store, SCOPE)
		const runMgr = makeRunMgrStub()

		const first = await mgr.create(runMgr, 1)
		const second = await mgr.create(runMgr, 2)
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
		await expect(mgr.restore('cp_missing' as CheckpointId)).rejects.toThrow(
			'Checkpoint not found: cp_missing',
		)
	})
})

// ─── cadence + prune via the iteration-checkpoint phase ──────────────────────

function makePhaseContext(
	store: InMemoryCheckpointStore,
	runConfig: { checkpointEvery?: number; pruneKeepLast?: number },
): { ctx: IterationContext; events: RunEvent[] } {
	const events: RunEvent[] = []
	const ctx = {
		runConfig: {
			model: 'mock-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			...runConfig,
		},
		runMgr: makeRunMgrStub(),
		checkpointMgr: new CheckpointManager(store, SCOPE),
		emitEvent: async (event: RunEvent) => {
			events.push(event)
		},
		// biome-ignore lint/correctness/useYield: drainPending is a no-op generator in this stub
		drainPending: function* (): Generator<RunEvent> {},
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
			(e): e is Extract<RunEvent, { type: 'checkpoint_created' }> =>
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

class OneToolCallProvider implements LLMProvider {
	readonly id = 'one-tool-call'
	readonly name = 'One Tool Call Provider'
	calls = 0

	async *chatStream(): AsyncIterable<StreamChunk> {
		this.calls += 1

		if (this.calls === 1) {
			yield {
				id: 'msg_1',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_echo_1',
							type: 'function',
							function: { name: 'echo', arguments: '{"text":"hi"}' },
						},
					],
				},
			}
			yield {
				id: 'msg_1',
				delta: { toolCallEnd: { index: 0, id: 'toolu_echo_1' } },
			}
			yield {
				id: 'msg_1',
				delta: {},
				finishReason: 'tool_calls',
				usage: ZERO_USAGE,
			}
			return
		}

		yield { id: 'msg_2', delta: { content: 'done' } }
		yield { id: 'msg_2', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
	}
}

describe('query() with an injected checkpointStore', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
		workdirs = []
	})

	it('persists iteration checkpoints into the injected store, keyed by run scope', async () => {
		const provider = new OneToolCallProvider()
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
			runConfig: {
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
			sessionId: 'ses_cp_inject' as SessionId,
			threadId: 'thd_cp_inject' as ThreadId,
			projectId: 'prj_cp_inject' as ProjectId,
			tenantId: 'tnt_cp_inject' as TenantId,
		})

		expect(run.status).toBe('completed')
		// The tool-call iteration produced at least one checkpoint, and it
		// landed in the injected store — not on disk.
		expect(store.rows.size).toBeGreaterThan(0)
		const scope = store.seenScopes[0]
		expect(scope?.tenantId).toBe('tnt_cp_inject')
		expect(scope?.projectId).toBe('prj_cp_inject')
		expect(scope?.sessionId).toBe('ses_cp_inject')
		expect(scope?.runId).toBe(run.id)
	})
})
