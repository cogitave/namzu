import { expect, it } from 'vitest'
import { describeRunStop } from './run-interruption.js'
it('distinguishes unmeasured requests from exhaustion even with unlimited execution', () => {
	const budget = {
		limit: 0,
		ownTokens: 0,
		treeTokens: 0,
		reservedTokens: 0,
		remainingTokens: 0,
		inFlightRequests: 1,
		unsettledChildren: 0,
		poisoned: true,
		unresolvedRequests: 1,
	}
	expect(describeRunStop('token_budget', budget)).toContain('could not be confirmed')
	expect(describeRunStop('token_budget', budget)).not.toContain('allowance')
	expect(describeRunStop('token_budget', { ...budget, unresolvedRequests: 0 })).toContain(
		'accounting',
	)
	expect(
		describeRunStop('token_budget', {
			...budget,
			limit: 100,
			poisoned: false,
			unresolvedRequests: 0,
		}),
	).toContain('allowance')
})
