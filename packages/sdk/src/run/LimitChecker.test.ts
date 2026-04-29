import { describe, expect, it } from 'vitest'

import { RuntimeConfigSchema } from '../config/runtime.js'
import { RunConfigSchema } from '../contracts/schemas.js'
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
				currentIteration: 1,
				startTime: Date.now(),
			},
		)

		expect(result).toEqual({ type: 'ok' })
	})

	it('accepts tokenBudget 0 in public runtime config schemas', () => {
		expect(RuntimeConfigSchema.parse({ tokenBudget: 0 }).tokenBudget).toBe(0)
		expect(RunConfigSchema.parse({ tokenBudget: 0 }).tokenBudget).toBe(0)
	})
})
