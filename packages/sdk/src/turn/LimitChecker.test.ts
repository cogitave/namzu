import { describe, expect, it } from 'vitest'

import { RuntimeConfigSchema } from '../config/runtime.js'
import { TurnConfigSchema } from '../contracts/session/index.js'
import { checkLimitsDetailed } from './LimitChecker.js'

describe('token budget limits', () => {
	it('treats tokenBudget 0 as unlimited at runtime', () => {
		const result = checkLimitsDetailed(
			{
				tokenBudget: 0,
				timeoutMs: 60_000,
				maxIterations: 10,
				budgetWarningThreshold: 0.9,
			},
			{
				aborted: false,
				totalTokens: 10_000_000,
				totalCost: 0,
				unpricedTokens: 0,
				currentIteration: 1,
				startTime: Date.now(),
			},
		)

		expect(result).toEqual({ type: 'ok' })
	})

	it('accepts tokenBudget 0 in public runtime config schemas', () => {
		expect(RuntimeConfigSchema.parse({ tokenBudget: 0 }).tokenBudget).toBe(0)
		expect(TurnConfigSchema.parse({ tokenBudget: 0 }).tokenBudget).toBe(0)
	})

	it('accepts an explicit stream-idle opt-out but refuses negative silence', () => {
		expect(TurnConfigSchema.parse({ streamIdleTimeoutMs: 0 }).streamIdleTimeoutMs).toBe(0)
		expect(() => TurnConfigSchema.parse({ streamIdleTimeoutMs: -1 })).toThrow()
	})

	it('accepts an explicit rich-content opt-out but refuses invalid byte budgets', () => {
		expect(
			TurnConfigSchema.parse({ maxRequestRichContentBytes: 0 }).maxRequestRichContentBytes,
		).toBe(0)
		expect(() => TurnConfigSchema.parse({ maxRequestRichContentBytes: -1 })).toThrow()
		expect(() => TurnConfigSchema.parse({ maxRequestRichContentBytes: 1.5 })).toThrow()
	})
})
