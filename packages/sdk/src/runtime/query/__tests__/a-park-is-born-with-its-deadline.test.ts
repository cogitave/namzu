import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { type QueryParams, query } from '../index.js'

/**
 * `runConfig.hitlParkTtlMs` reaches `CheckpointManager.setParkTtl` in exactly
 * one line, and nothing tested that line.
 *
 * The manager-level default is covered — `durable-park-and-trace.test.ts`
 * drives `setParkTtl` directly. What was not covered is the hop from a host's
 * config to that call. Delete it and every park a real run records becomes
 * immortal: the worker is redeployed, nobody answers, and the checkpoint
 * stays outstanding forever while every approval-queue reader keeps serving
 * it. The setting looks wired, the manager is correct, and nothing between
 * them carries the number — the same shape as the claim fence that was
 * complete except for its wire.
 */

class RecordingCheckpointStore implements CheckpointStore {
	private readonly rows = new Map<string, IterationCheckpoint>()

	private key(scope: CheckpointRunScope, checkpointId: CheckpointId): string {
		return [scope.tenantId, scope.projectId, scope.sessionId, scope.runId, checkpointId].join('/')
	}

	async writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void> {
		this.rows.set(this.key(scope, checkpoint.id), checkpoint)
	}

	async readCheckpoint(
		scope: CheckpointRunScope,
		checkpointId: CheckpointId,
	): Promise<IterationCheckpoint | null> {
		return this.rows.get(this.key(scope, checkpointId)) ?? null
	}

	async listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]> {
		const prefix = `${[scope.tenantId, scope.projectId, scope.sessionId, scope.runId].join('/')}/`
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, checkpoint]) => checkpoint)
			.sort((a, b) => a.createdAt - b.createdAt)
	}

	async deleteCheckpoint(scope: CheckpointRunScope, checkpointId: CheckpointId): Promise<void> {
		this.rows.delete(this.key(scope, checkpointId))
	}

	/** Every checkpoint this store holds, in write order. */
	all(): IterationCheckpoint[] {
		return [...this.rows.values()]
	}

	/** The parks nobody has answered. */
	outstanding(): IterationCheckpoint[] {
		return this.all().filter((cp) => cp.pending && cp.pending.resolvedAt === undefined)
	}
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const RUN_ID = fixtureId.run('park-deadline')
const SCOPE: CheckpointRunScope = {
	runId: RUN_ID,
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
}
const TENANT_ID = SCOPE.tenantId
const PROJECT_ID = SCOPE.projectId
const SESSION_ID = SCOPE.sessionId
const TOPIC_ID = generateTopicId()

/** A destructive call no gate pre-approves, so it reaches a human. */
function reviewRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'deploy',
			description: 'a destructive call that needs a human',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: async () => ({ success: true, output: 'deployed' }),
		}),
	)
	return tools
}

async function runUntilParked(options: { hitlParkTtlMs?: number }): Promise<{
	store: RecordingCheckpointStore
	events: RunEvent[]
	/**
	 * The parks as they stood while the run was still waiting — read before
	 * the abort, because a cancelled run resolves its own park on the way out
	 * and an outstanding-park assertion taken afterwards would be about the
	 * teardown rather than about the park.
	 */
	parked: IterationCheckpoint[]
	/** What a host's approval queue would have been served, at that moment. */
	servedWhileParked?: IterationCheckpoint | null
}> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-park-ttl-'))
	dirs.push(dir)
	const store = new RecordingCheckpointStore()
	const events: RunEvent[] = []
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ id: 'c1', name: 'deploy', args: {} }], finishReason: 'tool_calls' }],
	})

	// The handler never answers, so the park is still outstanding when the
	// test looks at it — and the run is cancelled from the outside once the
	// park is on the durable record.
	const caller = new AbortController()
	const drained = (async () => {
		const gen = query({
			provider,
			tools: reviewRegistry(),
			checkpointStore: store,
			agentId: 'agent_park_ttl',
			agentName: 'Park TTL agent',
			messages: [{ role: 'user', content: 'deploy it' }],
			workingDirectory: dir,
			runId: RUN_ID,
			tenantId: TENANT_ID,
			projectId: PROJECT_ID,
			sessionId: SESSION_ID,
			topicId: TOPIC_ID,
			signal: caller.signal,
			// Records the park on the next macrotask rather than after the
			// default quarter second.
			parkRecordDelayMs: 0,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
				...(options.hitlParkTtlMs !== undefined ? { hitlParkTtlMs: options.hitlParkTtlMs } : {}),
			},
			authorizationGate: {
				enabled: true,
				rules: [],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			resumeHandler: () => new Promise(() => {}),
		} as unknown as QueryParams)

		let next = await gen.next()
		while (!next.done) {
			events.push(next.value)
			next = await gen.next()
		}
		return next.value
	})()

	// Wait on the durable record, not on a duration: the park reaching the
	// store is exactly the fact under test.
	await vi.waitFor(() => expect(store.outstanding().length).toBeGreaterThan(0))
	const parked = store.outstanding()
	const servedWhileParked = await findPendingCheckpoint(store, SCOPE)
	caller.abort()
	await drained
	return { store, events, parked, servedWhileParked }
}

describe("a host's park time-to-live reaches the run that records the park", () => {
	it('stamps an ABSOLUTE deadline on the park a real run writes', async () => {
		const { parked: parkedList } = await runUntilParked({ hitlParkTtlMs: 60_000 })

		const parked = parkedList[0]
		expect(parked).toBeDefined()
		expect(parked?.pending?.request.type).toBe('tool_review')
		// Absolute, so it survives the process that set it. Without the hop
		// from `runConfig`, `setParkTtl` is never called, no deadline is
		// written, and this park is immortal — the manager would still be
		// right, and the run would still be wrong.
		expect(parked?.pending?.deadlineAt).toBe((parked?.pending?.parkedAt ?? 0) + 60_000)
	})

	it('writes no deadline when the host asked for none', async () => {
		// The default has to stay "no deadline": a host that never configured
		// one must not start losing approvals to a value the SDK invented.
		const { parked } = await runUntilParked({})

		// The premise, asserted rather than assumed: a park WAS recorded, so
		// its missing deadline is a fact about the config.
		expect(parked).toHaveLength(1)
		expect(parked[0]?.pending?.deadlineAt).toBeUndefined()
	})
})

describe('the time-to-live the run writes is the one the store will enforce', () => {
	it('serves the park before the deadline and stops serving it after', async () => {
		const { parked, servedWhileParked } = await runUntilParked({ hitlParkTtlMs: 60_000 })
		const recorded = parked[0] as IterationCheckpoint

		// Served while parked — which is what makes the second assertion a
		// statement about the deadline rather than about a park nobody ever
		// wrote.
		expect(servedWhileParked?.id).toBe(recorded.id)
		// And once the window has closed it is no longer served, so an
		// approval queue stops re-presenting a request nobody can answer.
		expect(
			await findPendingCheckpoint(recordedStore(recorded), SCOPE, {
				now: (recorded.pending?.deadlineAt ?? 0) + 1,
			}),
		).toBeNull()
	})
})

/** A one-row store holding exactly `checkpoint`, for a read taken later. */
function recordedStore(checkpoint: IterationCheckpoint): CheckpointStore {
	const store = new RecordingCheckpointStore()
	void store.writeCheckpoint(SCOPE, checkpoint)
	return store
}

describe('a park this run did not ask for', () => {
	it('is not made immortal by a time-to-live the run never got', async () => {
		// The negative control for the two cases above: with no TTL configured
		// there is no deadline to inherit, so nothing about this run's parks
		// can be expired — which is what makes the first case's positive
		// result a fact about the config rather than about parking at all.
		const { parked } = await runUntilParked({})
		expect(parked).toHaveLength(1)
		expect(parked[0]?.pending?.deadlineAt).toBeUndefined()

		// Nothing had answered it either, which is the state the deadline
		// exists to bound.
		expect(parked[0]?.pending?.resolvedAt).toBeUndefined()
	})
})
