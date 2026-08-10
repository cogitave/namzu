import { describe, expect, it } from 'vitest'

import { checkLimitsDetailed } from '../LimitChecker.js'

/**
 * A budget that cannot be measured must not read as a budget that is satisfied.
 *
 * `costLimitUsd` is compared against `totalCost`, and `totalCost` only counts
 * tokens something had a rate for. So a run partly (or wholly) priced at no
 * rate sits under any limit forever while spending without bound — which was
 * the state of every run before the price catalogue, since nothing fed the
 * calculation at all.
 *
 * `query()` refuses the configured model up front. This is the case preflight
 * cannot see: a step naming its own model, or a chain member declaring one.
 */

const config = {
	tokenBudget: 0,
	timeoutMs: 60_000,
	maxIterations: 100,
	budgetWarningThreshold: 0.9,
	costLimitUsd: 10,
}

const state = (over: Partial<Parameters<typeof checkLimitsDetailed>[1]> = {}) => ({
	aborted: false,
	totalTokens: 0,
	totalCost: 0,
	unpricedTokens: 0,
	currentIteration: 1,
	startTime: Date.now(),
	...over,
})

describe('costLimitUsd against a partly unpriced run', () => {
	it('stops, and names the measurement rather than the spend', () => {
		const result = checkLimitsDetailed(config, state({ unpricedTokens: 4_000 }))
		expect(result).toEqual({ type: 'hard_stop', reason: 'cost_unmeasurable' })
	})

	it('is a different answer from an exceeded budget', () => {
		// Reusing `cost_limit` would send the reader to look at spend that was
		// never computed, and would hide the fact they need: that their budget
		// was unenforceable. So the two must not collapse.
		const exceeded = checkLimitsDetailed(config, state({ totalCost: 10 }))
		const unmeasurable = checkLimitsDetailed(config, state({ unpricedTokens: 1 }))
		expect(exceeded).toEqual({ type: 'hard_stop', reason: 'cost_limit' })
		expect(unmeasurable).not.toEqual(exceeded)
	})

	it('reports the exceeded budget first when the run is both', () => {
		// Spend that provably crossed the line is the more actionable fact, and
		// it is certain where the other is a gap.
		const result = checkLimitsDetailed(config, state({ totalCost: 99, unpricedTokens: 4_000 }))
		expect(result).toEqual({ type: 'hard_stop', reason: 'cost_limit' })
	})

	it('does not fire when no cost limit was set', () => {
		// An unpriced run is only a problem for a budget. Firing here would
		// stop every run on every uncatalogued model, which is a far larger
		// change than the one being made.
		const noLimit = { ...config, costLimitUsd: undefined }
		expect(checkLimitsDetailed(noLimit, state({ unpricedTokens: 9_999 }))).toEqual({ type: 'ok' })
	})

	it('does not fire when the limit is zero, which means unlimited here', () => {
		const zero = { ...config, costLimitUsd: 0 }
		expect(checkLimitsDetailed(zero, state({ unpricedTokens: 9_999 }))).toEqual({ type: 'ok' })
	})

	it('leaves a fully priced run under its limit alone', () => {
		expect(checkLimitsDetailed(config, state({ totalCost: 1 }))).toEqual({ type: 'ok' })
	})
})
