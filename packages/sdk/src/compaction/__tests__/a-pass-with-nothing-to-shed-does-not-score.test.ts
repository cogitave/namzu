import { afterEach, describe, expect, it, vi } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { DEFAULT_SOFT_TARGET, planSalienceWorkingSet } from '../plan.js'
import { referenceScoreMessages } from '../salience/__tests__/reference-score.js'
import { buildGoal } from '../salience/goal.js'
import * as scoring from '../salience/score.js'
import * as tokenizer from '../salience/tokenize.js'
import { planWorkingSet } from '../salience/working-set.js'

/**
 * From the soft target to the summary trigger the pass runs on every turn,
 * and once every narration is cut and every large result cleared it can do
 * nothing, yet it scored every message to find that out. A cheap count of
 * what the pass is allowed to touch comes first now. These pin both halves:
 * the count is exact when it says "nothing" (the plan is the plan the full
 * pass makes), and no scoring work is done for it, for N and for 4N messages.
 */

const config = CompactionConfigSchema.parse({ strategy: 'salience', keepRecentMessages: 6 })
const WINDOW = 20_000
const OVER = Math.floor(WINDOW * DEFAULT_SOFT_TARGET) + 500

const call = (id: string): AssistantMessage => ({
	role: 'assistant',
	content: null,
	toolCalls: [
		{
			id,
			type: 'function',
			function: { name: 'bash', arguments: JSON.stringify({ command: 'true' }) },
		},
	],
})
const result = (id: string, text: string, extra: Partial<ToolMessage> = {}): ToolMessage => ({
	role: 'tool',
	toolCallId: id,
	content: text,
	...extra,
})

/** Turns that leave nothing sheddable: small results, short and already-cut narrations. */
function inert(turns: number): Message[] {
	const messages: Message[] = [
		{ role: 'system', content: 'sys' },
		{ role: 'user', content: 'start' },
	]
	for (let t = 0; t < turns; t += 1) {
		messages.push(
			call(`c${t}`),
			result(`c${t}`, 'ok'),
			{ role: 'assistant', content: 'short note.' },
			{ role: 'assistant', content: `first. … (elided; ${t + 900} characters of narration)` },
			call(`e${t}`),
			result(`e${t}`, 'x'.repeat(4_000), { isError: true }),
		)
	}
	return messages
}

function referencePlan(messages: Message[]) {
	const scored = referenceScoreMessages(messages, {
		goal: buildGoal(messages),
		keepRecentMessages: config.keepRecentMessages,
	})
	return planWorkingSet(messages, scored, {
		estimatedTokens: OVER,
		targetTokens: Math.floor(WINDOW * DEFAULT_SOFT_TARGET),
		minToolResultChars: config.minToolResultCharsToClear,
	})
}

afterEach(() => vi.restoreAllMocks())

describe('a pass with nothing it may shed', () => {
	it('is the plan the full pass makes, without scoring anything', () => {
		const score = vi.spyOn(scoring, 'scoreMessages')
		const tokenize = vi.spyOn(tokenizer, 'tokenize')
		for (const turns of [10, 40]) {
			const messages = inert(turns)
			score.mockClear()
			tokenize.mockClear()
			const plan = planSalienceWorkingSet({
				messages,
				config,
				contextWindowTokens: WINDOW,
				estimatedTokens: OVER,
			})
			const expected = referencePlan(messages)
			expect(score).not.toHaveBeenCalled()
			// The oracle tokenises; the pass under test must not have.
			expect(plan.clearedCount).toBe(expected.clearedCount)
			expect(plan.stubbedCount).toBe(expected.stubbedCount)
			expect(plan.reclaimedTokens).toBe(expected.reclaimedTokens)
			expect(plan.charsReclaimed).toBe(expected.charsReclaimed)
			expect(plan.working.reachedTarget).toBe(expected.reachedTarget)
			expect(plan.working.actions).toEqual(expected.actions)
			expect(plan.messages).toEqual(expected.messages)
			expect(plan.reclaimedTokens).toBe(0)
		}
	})

	it('does no tokenising for it, at N messages or at 4N', () => {
		const calls: number[] = []
		for (const turns of [10, 40]) {
			const messages = inert(turns)
			const tokenize = vi.spyOn(tokenizer, 'tokenize')
			tokenize.mockClear()
			planSalienceWorkingSet({
				messages,
				config,
				contextWindowTokens: WINDOW,
				estimatedTokens: OVER,
			})
			calls.push(tokenize.mock.calls.length)
			tokenize.mockRestore()
		}
		expect(calls).toEqual([0, 0])
	})

	it('does not count a narration or a result that only the recent window still holds', () => {
		const messages = inert(10)
		messages.push(call('big'), result('big', 'y '.repeat(3_000)), {
			role: 'assistant',
			content: 'A long closing narration. '.repeat(30),
		})
		const score = vi.spyOn(scoring, 'scoreMessages')
		planSalienceWorkingSet({ messages, config, contextWindowTokens: WINDOW, estimatedTokens: OVER })
		// The big result and the long narration are inside the last six messages: protected.
		expect(score).not.toHaveBeenCalled()
	})

	it('still scores, and still sheds, when something old is large', () => {
		const messages = inert(10)
		messages.splice(2, 0, call('old'), result('old', 'z '.repeat(3_000)))
		const score = vi.spyOn(scoring, 'scoreMessages')
		const plan = planSalienceWorkingSet({
			messages,
			config,
			contextWindowTokens: WINDOW,
			estimatedTokens: OVER,
		})
		const expected = referencePlan(messages)
		expect(score).toHaveBeenCalledTimes(1)
		expect(plan.clearedCount).toBe(1)
		expect(plan.working.actions).toEqual(expected.actions)
		expect(plan.messages).toEqual(expected.messages)
	})

	it('counts a preserved tool, an error and a cleared result as nothing to shed', () => {
		const withPreserve = CompactionConfigSchema.parse({
			strategy: 'salience',
			keepRecentMessages: 2,
			preserveToolResultsFrom: ['bash'],
		})
		const messages: Message[] = [
			{ role: 'system', content: 'sys' },
			{ role: 'user', content: 'go' },
			call('p'),
			result('p', 'q '.repeat(3_000)),
			{ role: 'assistant', content: 'done.' },
			{ role: 'user', content: 'thanks' },
			{ role: 'assistant', content: 'ok.' },
		]
		const score = vi.spyOn(scoring, 'scoreMessages')
		const plan = planSalienceWorkingSet({
			messages,
			config: withPreserve,
			contextWindowTokens: WINDOW,
			estimatedTokens: OVER,
		})
		expect(score).not.toHaveBeenCalled()
		expect(plan.reclaimedTokens).toBe(0)
		expect(plan.messages).toEqual(messages)
	})
})
