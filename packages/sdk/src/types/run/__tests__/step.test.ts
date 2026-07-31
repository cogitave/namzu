import { describe, expect, it } from 'vitest'

import type { StepResult, StopConditionState } from '../step.js'
import { anyOf, hasToolCall, stepCountIs } from '../step.js'

/**
 * The only halt before this was `GuardCoordinator`, which consumes
 * `{aborted, totalTokens, totalCost, currentIteration, startTime}` and never
 * sees messages, tool calls or results. So a terminal `submit_answer` tool
 * could not end a run — the model had to be prompt-begged to stop, with
 * `maxIterations: 200` or the token budget as the only backstop, which meant
 * a finished task still burned its whole envelope.
 */

function step(n: number, toolNames: string[] = []): StepResult {
	return {
		stepNumber: n,
		model: 'm',
		messageId: `msg_${n}` as StepResult['messageId'],
		content: null,
		toolCalls: toolNames.map((name, i) => ({
			id: `c${n}_${i}`,
			type: 'function' as const,
			function: { name, arguments: '{}' },
		})),
		toolResults: [],
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		costDelta: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
		startedAt: 0,
		durationMs: 0,
		toolExecutionMs: 0,
	}
}

function stateOf(steps: StepResult[]): StopConditionState {
	const latestStep = steps[steps.length - 1]
	if (!latestStep) throw new Error('need at least one step')
	return {
		steps,
		latestStep,
		totalUsage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		totalCost: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
	}
}

describe('stepCountIs', () => {
	it('is false before the count and true at it', async () => {
		const condition = stepCountIs(3)
		expect(await condition(stateOf([step(1), step(2)]))).toBe(false)
		expect(await condition(stateOf([step(1), step(2), step(3)]))).toBe(true)
	})

	it('stays true past the count — it is a floor, not an equality', async () => {
		expect(await stepCountIs(2)(stateOf([step(1), step(2), step(3)]))).toBe(true)
	})
})

describe('hasToolCall', () => {
	it('fires when the latest step called the named tool', async () => {
		expect(await hasToolCall('submit_answer')(stateOf([step(1, ['submit_answer'])]))).toBe(true)
	})

	it('does not fire on an earlier step — only the latest one is examined', async () => {
		const state = stateOf([step(1, ['submit_answer']), step(2, ['read'])])
		expect(await hasToolCall('submit_answer')(state)).toBe(false)
	})

	it('accepts several names', async () => {
		const condition = hasToolCall('submit_answer', 'give_up')
		expect(await condition(stateOf([step(1, ['give_up'])]))).toBe(true)
		expect(await condition(stateOf([step(1, ['read'])]))).toBe(false)
	})

	it('is false for a step with no tool calls at all', async () => {
		expect(await hasToolCall('x')(stateOf([step(1)]))).toBe(false)
	})
})

describe('anyOf', () => {
	it('fires when any condition does', async () => {
		const condition = anyOf(stepCountIs(99), hasToolCall('submit_answer'))
		expect(await condition(stateOf([step(1, ['submit_answer'])]))).toBe(true)
	})

	it('is false when none fire', async () => {
		const condition = anyOf(stepCountIs(99), hasToolCall('submit_answer'))
		expect(await condition(stateOf([step(1, ['read'])]))).toBe(false)
	})

	it('short-circuits — a later condition is not consulted once one fires', async () => {
		let consulted = false
		const condition = anyOf(
			() => true,
			() => {
				consulted = true
				return false
			},
		)
		expect(await condition(stateOf([step(1)]))).toBe(true)
		expect(consulted).toBe(false)
	})

	it('awaits an async condition', async () => {
		const condition = anyOf(async () => {
			await Promise.resolve()
			return true
		})
		expect(await condition(stateOf([step(1)]))).toBe(true)
	})
})
