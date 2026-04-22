/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 6):
 *
 *   - `AdvisoryContext` composes a registry + executor + evaluator +
 *     optional budget. It is a dumb container + a call-history log.
 *   - `recordCall(record)` appends to `callHistory` in call order.
 *   - `getBudgetStatus()`:
 *     - `used` = `callHistory.length`.
 *     - `total` = `budget?.maxCallsPerRun` (undefined when no budget).
 *     - `remaining` = total − used when total defined; undefined else.
 *   - `checkBudget()`:
 *     - Allowed when no budget OR remaining > 0.
 *     - Denied with reason when remaining ≤ 0.
 */

import { describe, expect, it } from 'vitest'

import type { AdvisoryCallRecord } from '../types/advisory/index.js'

import { AdvisoryContext } from './context.js'
import type { TriggerEvaluator } from './evaluator.js'
import type { AdvisoryExecutor } from './executor.js'
import type { AdvisorRegistry } from './registry.js'

function stubRegistry(): AdvisorRegistry {
	return {} as unknown as AdvisorRegistry
}

function stubExecutor(): AdvisoryExecutor {
	return {} as unknown as AdvisoryExecutor
}

function stubEvaluator(): TriggerEvaluator {
	return {} as unknown as TriggerEvaluator
}

function callRecord(id: string): AdvisoryCallRecord {
	return {
		advisorId: id,
		request: { question: 'q' },
		result: { advice: 'a' },
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
		cost: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
		durationMs: 0,
		iteration: 0,
		timestamp: Date.now(),
	}
}

describe('AdvisoryContext', () => {
	it('starts with empty callHistory', () => {
		const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator())
		expect(ctx.callHistory).toEqual([])
	})

	it('recordCall appends in order', () => {
		const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator())
		ctx.recordCall(callRecord('a'))
		ctx.recordCall(callRecord('b'))
		expect(ctx.callHistory.map((r) => r.advisorId)).toEqual(['a', 'b'])
	})

	describe('getBudgetStatus', () => {
		it('no budget → total + remaining undefined; used reflects history length', () => {
			const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator())
			ctx.recordCall(callRecord('a'))
			expect(ctx.getBudgetStatus()).toEqual({ used: 1, total: undefined, remaining: undefined })
		})

		it('with budget → total + remaining computed', () => {
			const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator(), {
				maxCallsPerRun: 3,
			})
			ctx.recordCall(callRecord('a'))
			expect(ctx.getBudgetStatus()).toEqual({ used: 1, total: 3, remaining: 2 })
		})
	})

	describe('checkBudget', () => {
		it('allowed when no budget', () => {
			const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator())
			expect(ctx.checkBudget()).toEqual({ allowed: true })
		})

		it('allowed when remaining > 0', () => {
			const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator(), {
				maxCallsPerRun: 2,
			})
			ctx.recordCall(callRecord('a'))
			expect(ctx.checkBudget()).toEqual({ allowed: true })
		})

		it('denied when remaining <= 0', () => {
			const ctx = new AdvisoryContext(stubRegistry(), stubExecutor(), stubEvaluator(), {
				maxCallsPerRun: 1,
			})
			ctx.recordCall(callRecord('a'))
			const result = ctx.checkBudget()
			expect(result.allowed).toBe(false)
			expect(result.reason).toMatch(/budget exhausted/)
		})
	})
})
