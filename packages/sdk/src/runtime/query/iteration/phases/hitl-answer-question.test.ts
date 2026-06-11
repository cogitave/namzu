import { describe, expect, it } from 'vitest'

import { type HITLResumeDecision, autoApproveHandler } from '../../../../types/hitl/index.js'
import type { CheckpointId, RunId } from '../../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../../types/provider/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import { type IterationContext, handleHITLDecision } from './context.js'
import { runToolReview } from './tool-review.js'

async function drainGenerator<TReturn>(
	gen: AsyncGenerator<RunEvent, TReturn>,
): Promise<{ events: RunEvent[]; value: TReturn }> {
	const events: RunEvent[] = []
	let next = await gen.next()
	while (!next.done) {
		events.push(next.value)
		next = await gen.next()
	}
	return { events, value: next.value }
}

describe('autoApproveHandler user_question case', () => {
	it('returns the non-fabricating no-answer sentinel with the questionId echoed', async () => {
		const decision = await autoApproveHandler({
			type: 'user_question',
			runId: 'run_headless_test' as RunId,
			checkpointId: 'cp_question_toolu_1' as CheckpointId,
			question: {
				questionId: 'toolu_1',
				question: 'Pick one?',
				options: [
					{ id: 'opt_1', label: 'A' },
					{ id: 'opt_2', label: 'B' },
				],
				multiSelect: false,
				allowFreeText: true,
			},
		})

		expect(decision).toEqual({
			action: 'answer_question',
			selectedOptionIds: [],
			freeText: 'No user is available to answer. Proceed using your best judgment.',
			questionId: 'toolu_1',
		})
	})
})

describe('handleHITLDecision answer_question case', () => {
	it("treats a misdirected 'answer_question' at an iteration checkpoint as continue", async () => {
		// The branch returns without touching the context — answers are
		// consumed inside the ask_user_question tool's own park, so an
		// answer arriving here can only be misdirected.
		const ctx = {} as IterationContext
		const { events, value } = await drainGenerator(
			handleHITLDecision(
				ctx,
				{ action: 'answer_question', selectedOptionIds: ['opt_1'] },
				'cp_checkpoint_1',
				'iteration checkpoint',
			),
		)
		expect(value).toBe('continue')
		expect(events).toEqual([])
	})
})

describe('runToolReview answer_question case', () => {
	function reviewContext(decision: HITLResumeDecision) {
		const warns: string[] = []
		const pushed: unknown[] = []
		let batches = 0
		const ctx = {
			tools: { get: () => undefined },
			checkpointMgr: {
				create: async () => ({ id: 'cp_review_1' as CheckpointId }),
			},
			emitEvent: async () => {},
			drainPending: (): Generator<RunEvent> => [][Symbol.iterator]() as Generator<RunEvent>,
			resumeHandler: async () => decision,
			log: {
				debug: () => {},
				info: () => {},
				warn: (message: string) => {
					warns.push(message)
				},
				error: () => {},
			},
			runMgr: {
				id: 'run_tool_review_test' as RunId,
				pushMessage: (message: unknown) => {
					pushed.push(message)
				},
			},
			toolExecutor: {
				executeBatch: async () => {
					batches += 1
					return { messages: [], results: [] }
				},
			},
		} as unknown as IterationContext
		return { ctx, warns, pushed, batchCount: () => batches }
	}

	const response: ChatCompletionResponse = {
		id: 'resp_1',
		model: 'test-model',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'toolu_review_1',
					type: 'function',
					function: { name: 'ask_user_question', arguments: '{}' },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}

	it("warns and executes the batch on a misdirected 'answer_question' instead of stalling", async () => {
		const { ctx, warns, batchCount } = reviewContext({
			action: 'answer_question',
			selectedOptionIds: [],
		})
		const { value } = await drainGenerator(runToolReview(ctx, response, 1))
		expect(value).toBe('executed')
		expect(batchCount()).toBe(1)
		expect(warns).toHaveLength(1)
	})
})
