import { describe, expect, it } from 'vitest'

import { type TokenUsage, accumulateTokenUsage, mergeTokenUsage } from '../../types/common/index.js'
import { CacheClock } from '../cache-clock.js'

const usage = (over: Partial<TokenUsage>): TokenUsage => ({
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
	...over,
})

const HOUR = 3_600_000
const FIVE = 300_000

describe('CacheClock', () => {
	it('expires a one-hour cache an hour after the call that wrote it', () => {
		const clock = new CacheClock()
		clock.record(usage({ cacheWriteTokens: 100, cacheTtlMs: HOUR }), 1_000)
		expect(clock.state).toEqual({
			lastActivityAt: 1_000,
			ttlMs: HOUR,
			expiresAt: 1_000 + HOUR,
		})
		expect(clock.warm(1_000 + HOUR - 1)).toBe(true)
		expect(clock.warm(1_000 + HOUR)).toBe(false)
	})

	it('counts a read as activity too', () => {
		const clock = new CacheClock()
		clock.record(usage({ cachedTokens: 80, cacheTtlMs: FIVE }), 0)
		expect(clock.state?.expiresAt).toBe(FIVE)
	})

	it('leaves the expiry unknown when the call touched no cache', () => {
		const clock = new CacheClock()
		clock.record(usage({ cacheTtlMs: HOUR }), 50)
		expect(clock.state?.expiresAt).toBeNull()
		expect(clock.dueAt(0.9)).toBeNull()
		expect(clock.warm(60)).toBe(false)
	})

	it('is never due when the driver states no lifetime', () => {
		const clock = new CacheClock()
		clock.record(usage({ cachedTokens: 500 }), 0)
		expect(clock.state).toBeNull()
		expect(clock.dueAt(0.9)).toBeNull()
	})

	it('forgets an earlier lifetime when a later call states none', () => {
		const clock = new CacheClock()
		clock.record(usage({ cachedTokens: 5, cacheTtlMs: HOUR }), 0)
		clock.record(usage({ cachedTokens: 5 }), 10)
		expect(clock.state).toBeNull()
	})

	it('is due at the given share of the life since the last activity', () => {
		const clock = new CacheClock()
		clock.record(usage({ cacheWriteTokens: 1, cacheTtlMs: HOUR }), 1_000)
		expect(clock.dueAt(0.9)).toBe(1_000 + 0.9 * HOUR)
		clock.record(usage({ cachedTokens: 1, cacheTtlMs: HOUR }), 5_000)
		expect(clock.dueAt(0.9)).toBe(5_000 + 0.9 * HOUR)
	})

	it('can be reset', () => {
		const clock = new CacheClock()
		clock.record(usage({ cachedTokens: 1, cacheTtlMs: HOUR }), 0)
		clock.reset()
		expect(clock.state).toBeNull()
	})
})

describe('the lifetime on usage', () => {
	it('is not summed across calls', () => {
		const sum = accumulateTokenUsage(usage({ cacheTtlMs: HOUR }), usage({ cacheTtlMs: HOUR }))
		expect(sum.cacheTtlMs).toBeUndefined()
	})

	it('is kept, latest wins, across frames of one call', () => {
		const merged = mergeTokenUsage(usage({ cacheTtlMs: HOUR }), usage({ cacheTtlMs: FIVE }))
		expect(merged.cacheTtlMs).toBe(FIVE)
		expect(mergeTokenUsage(usage({ cacheTtlMs: HOUR }), usage({})).cacheTtlMs).toBe(HOUR)
	})
})
