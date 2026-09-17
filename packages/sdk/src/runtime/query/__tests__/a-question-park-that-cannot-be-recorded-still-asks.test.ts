import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import type { CheckpointRunScope } from '../../../types/run/checkpoint-store.js'
import type { ToolPauseOutcome } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import type { RunStateScope } from '../run-state.js'

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

const SCOPE: RunStateScope = {
	runId: fixtureId.run('question-park-refused'),
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	topicId: generateTopicId(),
}

const PAUSE = {
	name: 'target_environment',
	prompt: 'which environment should this run against?',
	options: [
		{ id: 'staging', label: 'Staging' },
		{ id: 'production', label: 'Production' },
	],
}

/** A store that cannot write a question park, and can write everything else. */
class StoreRefusingQuestionParks extends InMemoryCheckpointStore {
	readonly refused: CheckpointId[] = []

	override async writeCheckpoint(
		scope: CheckpointRunScope,
		checkpoint: IterationCheckpoint,
		fence?: number,
	): Promise<void> {
		if (checkpoint.pending?.request.type === 'user_question') {
			this.refused.push(checkpoint.id)
			throw new Error('the checkpoint store refused this park')
		}
		return await super.writeCheckpoint(scope, checkpoint, fence as never)
	}
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function pausingRegistry(seen: Array<ToolPauseOutcome | undefined>): ToolRegistry {
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
				seen.push(await context.requestPause?.(PAUSE))
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
		const store = new StoreRefusingQuestionParks()
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
				tools: pausingRegistry(seen),
				checkpointStore: store,
				agentId: 'agent_question_refused',
				agentName: 'Question refusal agent',
				messages: [{ role: 'user', content: 'deploy it' }],
				workingDirectory,
				runId: SCOPE.runId,
				tenantId: SCOPE.tenantId,
				projectId: SCOPE.projectId,
				sessionId: SCOPE.sessionId,
				topicId: SCOPE.topicId,
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
				runConfig: {
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
		const store = new StoreRefusingQuestionParks()
		const seen: Array<ToolPauseOutcome | undefined> = []

		await drainQuery(
			{
				provider: new MockLLMProvider({
					turns: [
						{ toolCalls: [{ id: 'call_1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
						{ text: 'deployed' },
					],
				}),
				tools: pausingRegistry(seen),
				checkpointStore: store,
				agentId: 'agent_question_refused',
				agentName: 'Question refusal agent',
				messages: [{ role: 'user', content: 'deploy it' }],
				workingDirectory,
				runId: SCOPE.runId,
				tenantId: SCOPE.tenantId,
				projectId: SCOPE.projectId,
				sessionId: SCOPE.sessionId,
				topicId: SCOPE.topicId,
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
				runConfig: {
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
			(await store.listCheckpoints(SCOPE)).some(
				(cp) => cp.pending?.request.type === 'user_question',
			),
		).toBe(false)
	})
})
