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
import { defineTool } from '../../../tools/defineTool.js'
import type { Toolset } from '../../../toolsets/types.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { CheckpointId, SessionId } from '../../../types/ids/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { checkpointLogView } from '../session-storage.js'

/**
 * `turnConfig.checkpointEvery` and `turnConfig.pruneKeepLast` are read by the
 * iteration-checkpoint phase, and only by it.
 *
 * The existing coverage drives that phase with a hand-built
 * `IterationContext` — which proves the phase honours a `turnConfig` object
 * somebody constructed, not that a host's `turnConfig` ever becomes one. The
 * only `query()`-level test that touches checkpoints uses the default
 * cadence, so both knobs could be dropped on the way from `QueryParams` to
 * the phase and every test would still pass.
 */

/** The session's checkpoint store, counting the documents it holds. */
class RecordingCheckpointStore extends InMemorySessionCheckpointStore {
	private readonly held = new Set<CheckpointId>()
	readonly scopes: CheckpointScope[] = []

	override async write(
		scope: CheckpointScope,
		checkpoint: Checkpoint,
	): Promise<CheckpointWriteReceipt> {
		this.scopes.push(scope)
		const receipt = await super.write(scope, checkpoint)
		this.held.add(checkpoint.checkpointId)
		return receipt
	}

	override async delete(scope: CheckpointScope, checkpointId: CheckpointId): Promise<void> {
		await super.delete(scope, checkpointId)
		this.held.delete(checkpointId)
	}

	override async prune(scope: CheckpointScope, keepLast: number): Promise<CheckpointId[]> {
		const removed = await super.prune(scope, keepLast)
		for (const id of removed) this.held.delete(id)
		return removed
	}

	size(): number {
		return this.held.size
	}
}

/** A session held in memory, with the recording store beside its log. */
function session(sessionId: SessionId = generateSessionId()) {
	const sessionLog = new InMemorySessionLog({ sessionId })
	const store = new RecordingCheckpointStore({ log: checkpointLogView(sessionLog) })
	return { sessionId, sessionLog, store }
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A read-only tool the gate approves, so no review park is recorded. */
function echoToolset(): Toolset {
	return testToolset(
		defineTool({
			name: 'echo',
			description: 'echoes the text back',
			inputSchema: z.object({ text: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => ({ success: true, output: 'hi' }),
		}),
	)
}

/** Three tool-call iterations, then a closing text turn. */
function threeToolTurns(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'echo', args: { text: 'a' } }], finishReason: 'tool_calls' },
			{ toolCalls: [{ id: 'c2', name: 'echo', args: { text: 'b' } }], finishReason: 'tool_calls' },
			{ toolCalls: [{ id: 'c3', name: 'echo', args: { text: 'c' } }], finishReason: 'tool_calls' },
			{ text: 'done' },
		],
	})
}

async function runThreeIterations(turnConfig: Record<string, unknown>): Promise<{
	events: SessionEvent[]
	store: RecordingCheckpointStore
	turnId: ReturnType<typeof generateTurnId>
}> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-cadence-'))
	dirs.push(dir)
	const { sessionId, sessionLog, store } = session()
	const events: SessionEvent[] = []
	const turnId = generateTurnId()

	await drainQuery(
		{
			provider: threeToolTurns(),
			toolsets: [echoToolset()],
			sessionLog,
			checkpointStore: store,
			agentId: 'agent_cadence',
			agentName: 'Cadence agent',
			messages: [{ role: 'user', content: 'work' }],
			workingDirectory: dir,
			turnId,
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId,
			topicId: generateTopicId(),
			resumeHandler: autoApproveHandler,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
				...turnConfig,
			},
		} as unknown as QueryParams,
		(event) => {
			events.push(event)
		},
	)

	return { events, store, turnId }
}

const createdIterations = (events: readonly SessionEvent[]): number[] =>
	events
		.filter((event) => event.type === 'checkpoint_created')
		.map((event) => (event as Extract<SessionEvent, { type: 'checkpoint_created' }>).iteration)

describe('the checkpoint cadence a host configures', () => {
	it('defaults to a checkpoint on every tool iteration', async () => {
		const { events } = await runThreeIterations({})

		expect(createdIterations(events)).toEqual([1, 2, 3])
	})

	it('checkpoints only on the Nth tool iteration when asked to', async () => {
		const { events } = await runThreeIterations({ checkpointEvery: 2 })

		// Iterations 1, 1+N, 1+2N — and the first tool iteration is always
		// covered, so a crash before the first cadence hit still leaves
		// something to resume from.
		expect(createdIterations(events)).toEqual([1, 3])
	})

	it('keeps only the newest N checkpoints when pruning is configured', async () => {
		const unpruned = await runThreeIterations({})
		const pruned = await runThreeIterations({ pruneKeepLast: 1 })

		// Both runs create the same number of checkpoints; only the pruned one
		// deletes any. Asserting the comparison rather than an absolute count
		// keeps the claim about the wiring — the count depends on how many
		// parks the review path happens to record.
		expect(pruned.store.size()).toBeLessThan(unpruned.store.size())
		// And it did not delete everything: a pruned run still has the
		// newest checkpoint to resume from.
		expect(pruned.store.size()).toBeGreaterThan(0)
	})

	it('leaves the checkpoint set alone when the host asked for no pruning', async () => {
		// The premise behind the comparison above: with pruning off, nothing
		// bounds the set, so the pruned run being smaller is a fact about the
		// config and not about the two fixtures differing.
		const unpruned = await runThreeIterations({})
		expect(unpruned.store.size()).toBeGreaterThanOrEqual(3)
	})
})

describe('a resume can still see the scope the cadence wrote under', () => {
	it('writes every checkpoint under the turn attribution the query was given', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-cadence-scope-'))
		dirs.push(dir)
		const { sessionId, sessionLog, store } = session()
		const seen = store.scopes
		const turnId = generateTurnId()
		const tenantId = generateTenantId()
		const projectId = generateProjectId()

		await drainQuery({
			provider: threeToolTurns(),
			toolsets: [echoToolset()],
			sessionLog,
			checkpointStore: store,
			agentId: 'agent_cadence',
			agentName: 'Cadence agent',
			messages: [{ role: 'user', content: 'work' }],
			workingDirectory: dir,
			turnId,
			tenantId,
			projectId,
			sessionId,
			topicId: generateTopicId(),
			resumeHandler: autoApproveHandler,
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'allow_by_name', toolNames: ['echo'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 6,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams)

		expect(seen.length).toBeGreaterThan(0)
		expect(
			seen.every(
				(scope) =>
					scope.turnId === turnId &&
					scope.tenantId === tenantId &&
					scope.projectId === projectId &&
					scope.sessionId === sessionId,
			),
		).toBe(true)
	})
})
