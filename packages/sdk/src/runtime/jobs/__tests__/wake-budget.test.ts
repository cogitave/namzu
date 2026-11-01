import { describe, expect, it } from 'vitest'

import { WakeBudget, wakeBudgetFromEnv } from '../wake-budget.js'

describe('the wake budget', () => {
	it('never limits unless asked to', () => {
		const budget = new WakeBudget()
		for (let i = 0; i < 1000; i++) budget.recordWake()
		expect(budget.canWake).toBe(true)
	})

	it('stops waking after the allowed number in a row, and only a person resets it', () => {
		const budget = new WakeBudget(2)
		budget.recordWake()
		expect(budget.canWake).toBe(true)
		budget.recordWake()
		expect(budget.canWake).toBe(false)
		expect(budget.consecutiveWakes).toBe(2)
		budget.reset()
		expect(budget.canWake).toBe(true)
	})

	it('treats anything but a positive integer as no limit', () => {
		for (const max of [0, -1, 1.5, Number.NaN]) {
			const budget = new WakeBudget(max)
			budget.recordWake()
			expect(budget.canWake).toBe(true)
		}
	})

	it('reads the limit from the environment, off when unset or malformed', () => {
		const exhausted = (env: Record<string, string | undefined>) => {
			const budget = wakeBudgetFromEnv(env)
			budget.recordWake()
			return !budget.canWake
		}
		expect(exhausted({ NAMZU_MAX_CONSECUTIVE_WAKES: '1' })).toBe(true)
		expect(exhausted({})).toBe(false)
		expect(exhausted({ NAMZU_MAX_CONSECUTIVE_WAKES: 'lots' })).toBe(false)
	})
})
