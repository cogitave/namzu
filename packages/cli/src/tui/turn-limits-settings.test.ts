import { describe, expect, it } from 'vitest'
import { resolveTurnGuards } from '../config/turn-guards.js'
import { formatTurnLimit, turnLimitsAction } from './turn-limits-settings.js'

describe('run limits settings', () => {
	it('defaults to unlimited and lets explicit zeros remove inherited caps', () => {
		expect(resolveTurnGuards()).toEqual({ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 })
		expect(
			resolveTurnGuards(
				{ tokenBudget: 1000, maxIterations: 20, timeoutMs: 60000 },
				{ tokenBudget: 0 },
			),
		).toEqual({ tokenBudget: 0, maxIterations: 20, timeoutMs: 60000 })
	})
	it.each([
		[['tokens', '0'], { tokenBudget: 0 }],
		[['iterations', 'unlimited'], { maxIterations: 0 }],
		[['tokens', '200000'], { tokenBudget: 200000 }],
		[['time', '1.5h'], { timeoutMs: 5400000 }],
		[['time', '30m'], { timeoutMs: 1800000 }],
		[['time', '1500'], { timeoutMs: 1500 }],
		[['unlimited'], { tokenBudget: 0, maxIterations: 0, timeoutMs: 0 }],
	] as const)('admits %j as %j', (input, limits) => {
		expect(turnLimitsAction(input)).toEqual({ kind: 'turn-limits-set', limits })
	})
	it.each([
		['tokens', '-1'],
		['tokens', '1.5'],
		['tokens', ''],
		['tokens', '1e6'],
		['tokens', '9007199254740992'],
		['time', '2147483648'],
		['time', '600h'],
		['time', '0.0001s'],
		['iterations', 'Infinity'],
		['unknown'],
		['tokens', '2', 'extra'],
	])('refuses invalid input %j without producing a setting', (...input) => {
		expect(turnLimitsAction(input)).toMatchObject({ kind: 'message' })
	})
	it('renders units without losing configured precision', () => {
		expect(formatTurnLimit('timeoutMs', 0)).toBe('Unlimited')
		expect(formatTurnLimit('timeoutMs', 3600000)).toBe('1h')
		expect(formatTurnLimit('timeoutMs', 1501)).toBe('1501ms')
	})
})
