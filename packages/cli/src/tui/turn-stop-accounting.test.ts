import { expect, it } from 'vitest'
import { describeTurnStop } from './turn-interruption.js'
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
	expect(describeTurnStop('token_budget', budget)).toContain('could not confirm')
	expect(describeTurnStop('token_budget', budget)).not.toContain('token limit')
	expect(describeTurnStop('token_budget', { ...budget, unresolvedRequests: 0 })).toContain(
		'could not be checked',
	)
	expect(
		describeTurnStop('token_budget', {
			...budget,
			limit: 100,
			poisoned: false,
			unresolvedRequests: 0,
		}),
	).toContain('token limit')
})
