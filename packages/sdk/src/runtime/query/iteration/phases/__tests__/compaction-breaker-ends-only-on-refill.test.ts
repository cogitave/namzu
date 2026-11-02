import { describe, expect, it } from 'vitest'

import {
	COMPACTION_FAILURE_LIMIT,
	COMPACTION_REFILL_LIMIT,
	CompactionBreaker,
} from '../compaction-breaker.js'

/**
 * Repeated failed passes only switch proactive compaction off for the turn;
 * the turn carries on. Only a run of full, quick refills ends it. A summary
 * that lands at 90-100% of its trigger is a refill, which is what a 32,000
 * trigger on a mis-sized window produced (11 compactions in 3 minutes).
 */
describe('which compaction outcomes end a turn', () => {
	it('carries on after the failure limit: proactive compaction stops, the turn does not', () => {
		const breaker = new CompactionBreaker()
		for (let i = 0; i < COMPACTION_FAILURE_LIMIT; i++) breaker.recordFailure()
		expect(breaker.failuresOpen).toBe(true)
		expect(breaker.stop).toBeUndefined()
	})

	it('ends the turn only on the third full refill in a row (the fourth pass is refused)', () => {
		const breaker = new CompactionBreaker()
		let iteration = 0
		const compact = (before: number, after: number) => {
			iteration += 1
			const trips = breaker.wouldTrip(iteration, before)
			if (!trips) breaker.recordCompaction(iteration, before, after)
			return trips
		}
		// Each pass sheds a little and the next iteration refills it all.
		const outcomes = Array.from({ length: COMPACTION_REFILL_LIMIT + 1 }, () =>
			compact(36_000, 30_000),
		)
		expect(outcomes).toEqual([false, false, false, true])
	})
})
