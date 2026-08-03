import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLResumeDecision } from '../../../types/hitl/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ToolPauseOutcome } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { PendingAnswers, QuestionParkBinding } from '../question-park.js'
import { createToolPause, pauseId } from '../tool-pause.js'

/**
 * The pause machinery is durable and excellent, and it was reachable from
 * exactly four kernel-owned points: the plan gate, the tool-review gate,
 * the iteration cadence, and one built-in question tool. A host-authored
 * tool — the spend, the outbound post, the destructive migration — had no
 * seam to it, and nothing in the type a tool author is handed suggested
 * one could be hand-wired.
 */

registerMock()

const ANSWER = (id: string, option: string): HITLResumeDecision => ({
	action: 'answer_question',
	questionId: id,
	selectedOptionIds: [option],
})

const request = {
	name: 'target_environment',
	prompt: 'which environment should this run against?',
	options: [
		{ id: 'staging', label: 'Staging' },
		{ id: 'production', label: 'Production' },
	],
}

describe('a pause raised from inside a tool', () => {
	it('records a durable park and returns the human answer', async () => {
		const record = vi.fn(async () => 'cp_1' as never)
		const resolve = vi.fn(async () => {})
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler: async (r) =>
				ANSWER(r.type === 'user_question' ? r.question.questionId : '', 'staging'),
			recorder: { record, resolve },
		})

		expect(await pause(request)).toEqual({ status: 'answered', selectedOptionIds: ['staging'] })
		expect(record).toHaveBeenCalledTimes(1)
		// Cleared once answered, so an approval queue stops serving it.
		expect(resolve).toHaveBeenCalledWith(
			'cp_1',
			expect.objectContaining({ action: 'answer_question' }),
		)
	})

	it('names the pause so one call can raise more than one', () => {
		// The tool-use id identifies the CALL, and a call may ask "which
		// environment" and then "are you sure" — keying on the id alone would
		// deliver the first answer to the second question.
		expect(pauseId('call_1', 'target_environment')).not.toBe(pauseId('call_1', 'confirm'))
	})

	it('refuses an answer addressed to a different pause', async () => {
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler: async () => ANSWER('call_1:some_other_pause', 'production'),
		})

		// Host queues are keyed by run, so a stale client can answer pause N
		// after pause N+1 opened. Answering the wrong one is worse than not
		// answering.
		expect(await pause(request)).toMatchObject({ status: 'unanswered' })
	})

	it('reports an unanswered pause as its own outcome, never as consent', async () => {
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler: async () => ({ action: 'continue' }),
		})

		const outcome: ToolPauseOutcome = await pause(request)
		expect(outcome.status).toBe('unanswered')
		expect(outcome).not.toHaveProperty('selectedOptionIds')
	})

	it('reports an abort separately from silence', async () => {
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler: async () => ({ action: 'abort', reason: 'stop' }),
		})

		expect(await pause(request)).toEqual({ status: 'aborted' })
	})

	it('drops a selection the tool never offered', async () => {
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler: async () => ANSWER('call_1:target_environment', 'delete_everything'),
		})

		expect(await pause(request)).toMatchObject({ status: 'unanswered' })
	})

	it('answers from a resumed run without parking again', async () => {
		const record = vi.fn(async () => 'cp_1' as never)
		const answers = new PendingAnswers()
		answers.set(
			pauseId('call_1', 'target_environment'),
			ANSWER('call_1:target_environment', 'production'),
		)

		const parkHandler = vi.fn(async () => ({ action: 'continue' }) as HITLResumeDecision)
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler,
			recorder: { record, resolve: async () => {} },
			pendingAnswers: answers,
		})

		expect(await pause(request)).toEqual({ status: 'answered', selectedOptionIds: ['production'] })
		// Re-entering the tool is HOW the answer is delivered, so it must not
		// ask the human something they already answered.
		expect(parkHandler).not.toHaveBeenCalled()
		expect(record).not.toHaveBeenCalled()
	})

	it('still pauses in-process when nothing durable is attached', async () => {
		// Unbound is the pre-run state, and the degradation is the same one
		// the built-in question tool has: the await works, only the
		// cross-process handoff is missing.
		const pause = createToolPause({
			runId: 'run_1' as never,
			toolUseId: 'call_1',
			parkHandler: async () => ANSWER('call_1:target_environment', 'staging'),
			recorder: new QuestionParkBinding(),
		})

		expect(await pause(request)).toEqual({ status: 'answered', selectedOptionIds: ['staging'] })
	})
})

describe('the seam a tool author is handed', () => {
	async function runToolThatPauses(turns: MockTurn[], seen: { outcome?: ToolPauseOutcome }) {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'deploy',
				description: 'deploy tool',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async (_input, context) => {
					seen.outcome = await context.requestPause?.(request)
					return { success: true, output: `pause: ${seen.outcome?.status ?? 'no seam'}` }
				},
			}),
		)

		return drainQuery({
			provider: new MockLLMProvider({ turns }),
			tools,
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'deploy it' }],
			workingDirectory: process.cwd(),
			runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 3 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			threadId: generateThreadId(),
			tenantId: generateTenantId(),
			resumeHandler: async () => ANSWER('call_1:target_environment', 'staging'),
		} as never)
	}

	it('reaches a host-authored tool through the tool context', async () => {
		const seen: { outcome?: ToolPauseOutcome } = {}
		await runToolThatPauses(
			[
				{
					toolCalls: [{ id: 'call_1', name: 'deploy', args: {} }],
					finishReason: 'tool_calls',
				},
				{ text: 'deployed' },
			],
			seen,
		)

		expect(seen.outcome).toEqual({ status: 'answered', selectedOptionIds: ['staging'] })
	})
})
