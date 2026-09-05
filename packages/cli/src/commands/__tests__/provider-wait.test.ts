import { describe, expect, it } from 'vitest'

import { FIRST_WAIT_MS, MAX_WAIT_MS, MIN_WAIT_MS, durationMs, pauseWait } from '../provider-wait.js'

describe('how long a paused run waits', () => {
	it('takes the delay the provider asked for', () => {
		expect(pauseWait({ waited: 0, retryAfterMs: 30_000, waitedMs: 0, budgetMs: 600_000 })).toEqual({
			kind: 'wait',
			delayMs: 30_000,
		})
	})

	it('does not poll a provider that asked for no time at all', () => {
		// `retryAfterMs: 0` is "now" from the provider and would mean an
		// immediate resume into the same limit; a floor keeps it a wait.
		expect(pauseWait({ waited: 0, retryAfterMs: 0, waitedMs: 0, budgetMs: 600_000 })).toEqual({
			kind: 'wait',
			delayMs: MIN_WAIT_MS,
		})
	})

	it('backs off when the provider named no delay, and caps the backoff', () => {
		const budgetMs = 24 * 3_600_000
		expect(pauseWait({ waited: 0, waitedMs: 0, budgetMs })).toEqual({
			kind: 'wait',
			delayMs: FIRST_WAIT_MS,
		})
		expect(pauseWait({ waited: 1, waitedMs: 0, budgetMs })).toEqual({
			kind: 'wait',
			delayMs: FIRST_WAIT_MS * 2,
		})
		expect(pauseWait({ waited: 10, waitedMs: 0, budgetMs })).toEqual({
			kind: 'wait',
			delayMs: MAX_WAIT_MS,
		})
	})

	it('stops rather than overrun the budget, and says why', () => {
		const decision = pauseWait({
			waited: 2,
			retryAfterMs: 120_000,
			waitedMs: 500_000,
			budgetMs: 600_000,
		})
		expect(decision.kind).toBe('stop')
		if (decision.kind === 'stop') {
			expect(decision.reason).toContain('2 minutes')
			expect(decision.reason).toContain('10 minutes')
		}
	})

	it('has nothing to wait with when no budget was given', () => {
		expect(pauseWait({ waited: 0, retryAfterMs: 5_000, waitedMs: 0, budgetMs: 0 }).kind).toBe(
			'stop',
		)
	})
})

describe('a duration on the command line', () => {
	it('reads seconds, minutes, hours and a bare number of seconds', () => {
		expect(durationMs('90s', '--wait-for-provider')).toBe(90_000)
		expect(durationMs('30m', '--wait-for-provider')).toBe(1_800_000)
		expect(durationMs('2h', '--wait-for-provider')).toBe(7_200_000)
		expect(durationMs('500ms', '--wait-for-provider')).toBe(500)
		expect(durationMs('45', '--wait-for-provider')).toBe(45_000)
		expect(durationMs('1.5m', '--wait-for-provider')).toBe(90_000)
	})

	it('refuses anything else, naming the flag', () => {
		expect(() => durationMs('soon', '--wait-for-provider')).toThrow(/--wait-for-provider/)
		expect(() => durationMs('0', '--wait-for-provider')).toThrow(/above zero/)
		expect(() => durationMs('-5m', '--wait-for-provider')).toThrow(/--wait-for-provider/)
		expect(() => durationMs('3d', '--wait-for-provider')).toThrow(/--wait-for-provider/)
	})
})
