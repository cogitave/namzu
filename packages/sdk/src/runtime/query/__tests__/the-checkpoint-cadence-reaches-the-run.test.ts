import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/session/durable.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateTurnId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'

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

	size(): number {
		return this.rows.size
	}
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A read-only tool the gate approves, so no review park is recorded. */
function echoRegistry(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
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
	return tools
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
	const store = new RecordingCheckpointStore()
	const events: SessionEvent[] = []
	const runId = generateTurnId()

	await drainQuery(
		{
			provider: threeToolTurns(),
			tools: echoRegistry(),
			checkpointStore: store,
			agentId: 'agent_cadence',
			agentName: 'Cadence agent',
			messages: [{ role: 'user', content: 'work' }],
			workingDirectory: dir,
			turnId,
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
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

	return { events, store, runId }
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
	it('writes every checkpoint under the run attribution the query was given', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-cadence-scope-'))
		dirs.push(dir)
		const store = new RecordingCheckpointStore()
		const seen: CheckpointRunScope[] = []
		const original = store.writeCheckpoint.bind(store)
		store.writeCheckpoint = async (scope, checkpoint) => {
			seen.push(scope)
			await original(scope, checkpoint)
		}
		const runId = generateTurnId()
		const tenantId = generateTenantId()
		const projectId = generateProjectId()
		const sessionId = generateSessionId()

		await drainQuery({
			provider: threeToolTurns(),
			tools: echoRegistry(),
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
					scope.runId === runId &&
					scope.tenantId === tenantId &&
					scope.projectId === projectId &&
					scope.sessionId === sessionId,
			),
		).toBe(true)
	})
})
