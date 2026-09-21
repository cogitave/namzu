import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { CheckpointScope, SessionCheckpointStore } from '../../../store/checkpoint/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import type { ToolPauseOutcome } from '../../../types/tool/index.js'
import { readParks } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { checkpointStoreFor, memorySession } from './support/session.js'

/**
 * The run-level arm of "a store that cannot record the park must not take
 * the tool down with it".
 *
 * The binding-level contract is covered — `durable-question-park.test.ts`
 * hands a hand-written recorder that returns `null` and proves the tool
 * still asks. What nothing covered is the `try`/`catch` around it inside
 * `query()` itself, which is the arm that runs when the STORE throws — a
 * disk full, a revoked credential, a backend that is simply down. The
 * question is still asked in-process and the answer still reaches the tool;
 * only the cross-process handoff is lost.
 *
 * A question that is lost loudly is a deployment problem. A question that
 * takes the tool down with it is a run that dies for a reason nobody can
 * act on.
 */

const PAUSE = {
	name: 'target_environment',
	prompt: 'which environment should this run against?',
	options: [
		{ id: 'staging', label: 'Staging' },
		{ id: 'production', label: 'Production' },
	],
}

/**
 * A checkpoint store that refuses every write while `refusing` is set: the
 * tool sets it around its question, so the checkpoint a question park
 * writes is the one refused, and every other checkpoint is written.
 */
class StoreRefusingDuringQuestions implements SessionCheckpointStore {
	readonly refused: CheckpointId[] = []
	refusing = false
	constructor(private readonly inner: SessionCheckpointStore) {}
	async write(scope: CheckpointScope, checkpoint: Checkpoint) {
		if (this.refusing) {
			this.refused.push(checkpoint.checkpointId)
			throw new Error('the checkpoint store refused this park')
		}
		return this.inner.write(scope, checkpoint)
	}
	read(scope: CheckpointScope, id: CheckpointId) {
		return this.inner.read(scope, id)
	}
	restore(scope: CheckpointScope, id: CheckpointId) {
		return this.inner.restore(scope, id)
	}
	list(scope: CheckpointScope) {
		return this.inner.list(scope)
	}
	delete(scope: CheckpointScope, id: CheckpointId) {
		return this.inner.delete(scope, id)
	}
	prune(scope: CheckpointScope, keepLast: number) {
		return this.inner.prune(scope, keepLast)
	}
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function pausingRegistry(
	seen: Array<ToolPauseOutcome | undefined>,
	store: StoreRefusingDuringQuestions,
): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'deploy',
			description: 'asks before it deploys',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async (_input, context) => {
				store.refusing = true
				try {
					seen.push(await context.requestPause?.(PAUSE))
				} finally {
					store.refusing = false
				}
				return { success: true, output: 'deployed' }
			},
		}),
	)
	return tools
}

describe('a question whose park cannot be recorded', () => {
	it('is still asked in-process, and the answer still reaches the tool', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-question-refused-'))
		dirs.push(workingDirectory)
		const session = memorySession()
		const store = new StoreRefusingDuringQuestions(checkpointStoreFor(session.sessionLog))
		const seen: Array<ToolPauseOutcome | undefined> = []
		const asked: HITLDecisionRequest['type'][] = []

		const run = await drainQuery(
			{
				provider: new MockLLMProvider({
					turns: [
						{ toolCalls: [{ id: 'call_1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
						{ text: 'deployed to staging' },
					],
				}),
				tools: pausingRegistry(seen, store),
				...session,
				checkpointStore: store,
				agentId: 'agent_question_refused',
				agentName: 'Question refusal agent',
				messages: [{ role: 'user', content: 'deploy it' }],
				workingDirectory,
				authorizationGate: {
					enabled: true,
					rules: [{ type: 'allow_by_name', toolNames: ['deploy'] }],
					allowReadOnlyTools: false,
					denyDangerousPatterns: false,
					logDecisions: false,
				},
				resumeHandler: async (request: HITLDecisionRequest) => {
					asked.push(request.type)
					return request.type === 'user_question'
						? {
								action: 'answer_question',
								questionId: request.question.questionId,
								selectedOptionIds: ['staging'],
							}
						: { action: 'continue' }
				},
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 30_000,
					tokenBudget: 100_000,
					maxIterations: 4,
					maxResponseTokens: 256,
				},
			} as unknown as QueryParams,
			(_event) => {},
		)

		// The catch fired: the store really did refuse the park, so the tool
		// below is being served by the in-process path and not by a store that
		// quietly worked.
		expect(store.refused.length).toBeGreaterThan(0)
		expect(run.status).toBe('completed')
		// The tool was still asked, and the option a human chose came back to
		// the tool that asked for it — the whole point of the symptom-first
		// path.
		expect(asked).toContain('user_question')
		expect(seen).toEqual([{ status: 'answered', selectedOptionIds: ['staging'] }])
	})

	it('leaves no park behind, which is the half that IS lost', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-question-refused-'))
		dirs.push(workingDirectory)
		const session = memorySession()
		const store = new StoreRefusingDuringQuestions(checkpointStoreFor(session.sessionLog))
		const seen: Array<ToolPauseOutcome | undefined> = []

		await drainQuery(
			{
				provider: new MockLLMProvider({
					turns: [
						{ toolCalls: [{ id: 'call_1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
						{ text: 'deployed' },
					],
				}),
				tools: pausingRegistry(seen, store),
				...session,
				checkpointStore: store,
				agentId: 'agent_question_refused',
				agentName: 'Question refusal agent',
				messages: [{ role: 'user', content: 'deploy it' }],
				workingDirectory,
				authorizationGate: {
					enabled: true,
					rules: [{ type: 'allow_by_name', toolNames: ['deploy'] }],
					allowReadOnlyTools: false,
					denyDangerousPatterns: false,
					logDecisions: false,
				},
				resumeHandler: async (request: HITLDecisionRequest) =>
					request.type === 'user_question'
						? {
								action: 'answer_question',
								questionId: request.question.questionId,
								selectedOptionIds: ['staging'],
							}
						: { action: 'continue' },
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 30_000,
					tokenBudget: 100_000,
					maxIterations: 4,
					maxResponseTokens: 256,
				},
			} as unknown as QueryParams,
			(_event) => {},
		)

		// Named plainly because it is the cost of the recovery: a host
		// building an approval queue from durable state never sees this
		// question, and a process that died mid-park could not have resumed
		// it. The run is unaffected; the cross-process handoff is gone.
		expect(store.refused).toHaveLength(1)
		expect(store.refused[0]).toMatch(/^[0-9a-f-]{36}$/)
		expect(
			(await readParks(session.sessionLog)).some(
				(park) => park.pending.request.type === 'user_question',
			),
		).toBe(false)
	})
})
