import { describe, expect, it } from 'vitest'

import type { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import type { CheckpointSummary } from '../../../types/hitl/index.js'
import type { TurnId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { CheckpointManager } from '../checkpoint.js'

/**
 * `CheckpointManager.buildSummary` is the card a human is shown before they
 * are asked to let a turn continue. It had zero references in the test tree,
 * which for a projection this small means no test ever looked at the text a
 * person actually reads — and the interesting cases are exactly the ones a
 * plausible implementation gets wrong: the last assistant turn of a
 * tool-calling turn has `content: null`, so "the last assistant message" and
 * "the last assistant message with something in it" are different answers.
 */

interface StubState {
	messages: unknown[]
	tokenUsage: Record<string, number>
	costInfo: Record<string, number>
	currentIteration: number
}

function runMgrStub(state: Partial<StubState>): TurnRecorder {
	return {
		id: 'e5f5c1c4-4b2a-4f8b-8f7b-7e7a1c2d3e4f' as TurnId,
		messages: [],
		tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		costInfo: {
			inputCostPer1M: 0,
			outputCostPer1M: 0,
			totalCost: 0,
			cacheDiscount: 0,
			unpricedTokens: 0,
		},
		currentIteration: 1,
		getSession: () => ({ startedAt: Date.now() }),
		...state,
	} as unknown as TurnRecorder
}

describe('the summary a turn hands a human', () => {
	it('counts the messages and names the iteration it was taken at', () => {
		const recorder = runMgrStub({
			messages: [
				createUserMessage('do the thing'),
				createAssistantMessage('starting'),
				createToolMessage('ok', 'call_1'),
			],
		})

		const summary = CheckpointManager.buildSummary(recorder, 4)

		expect(summary.iteration).toBe(4)
		expect(summary.messageCount).toBe(3)
		expect(summary.lastAssistantMessage).toBe('starting')
	})

	it('shows the last thing the model actually SAID, not its empty tool-call turn', () => {
		// The live case: iteration N ended with the model asking for a tool
		// and nothing else. A card built from "the last assistant message"
		// arrives blank exactly when a human is being asked to approve
		// something, which is the worst possible moment to show them nothing.
		const recorder = runMgrStub({
			messages: [
				createUserMessage('do the thing'),
				createAssistantMessage('here is what I found so far'),
				createAssistantMessage(null, [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'deploy', arguments: '{}' },
					},
				]),
				createToolMessage('deployed', 'call_1'),
			],
		})

		const summary = CheckpointManager.buildSummary(recorder, 2)

		expect(summary.lastAssistantMessage).toBe('here is what I found so far')
		expect(summary.messageCount).toBe(4)
	})

	it('leaves the message undefined when the model has not spoken yet', () => {
		// `undefined`, not `''` and not the word "null": a card with no
		// assistant text must render as absent rather than as an empty quote.
		const recorder = runMgrStub({ messages: [createUserMessage('do the thing')] })

		const summary = CheckpointManager.buildSummary(recorder, 1)

		expect(summary.lastAssistantMessage).toBeUndefined()
	})

	it('reports the usage as it stood, not as it later became', () => {
		// The summary is a record of the moment the park was taken. Holding
		// the live object would have the numbers on the human's card keep
		// moving while they read it.
		const recorder = runMgrStub({
			messages: [createUserMessage('go')],
			tokenUsage: { promptTokens: 1_200, completionTokens: 340, totalTokens: 1_540 },
			costInfo: {
				inputCostPer1M: 3,
				outputCostPer1M: 15,
				totalCost: 0.0087,
				cacheDiscount: 0,
				unpricedTokens: 0,
			},
		})
		const live = (recorder as unknown as StubState).tokenUsage

		const summary: CheckpointSummary = CheckpointManager.buildSummary(recorder, 3)
		live.promptTokens = 99_999

		expect(summary.tokenUsage.promptTokens).toBe(1_200)
		expect(summary.tokenUsage.totalTokens).toBe(1_540)
		expect(summary.costInfo.totalCost).toBeCloseTo(0.0087)
	})

	it('ignores a non-assistant tail when picking the last thing said', () => {
		const recorder = runMgrStub({
			messages: [
				createUserMessage('go'),
				createAssistantMessage('the answer'),
				createToolMessage('tool output', 'call_9'),
			],
		})

		expect(CheckpointManager.buildSummary(recorder, 1).lastAssistantMessage).toBe('the answer')
	})
})
