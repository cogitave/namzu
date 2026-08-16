import { describe, expect, it } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
import type { MessageId } from '../../../types/ids/index.js'
import { InMemoryMessageFeedbackStore, acceptAnyMessage } from '../memory.js'
import type { FeedbackRating } from '../types.js'

/**
 * `rating` is two values and the compiler knows it.
 *
 * A number invites a mean nobody can interpret across raters; an open
 * string turns every consumer into a parser of somebody else's vocabulary.
 * Asserted at the TYPE level because that is where the property lives — a
 * runtime check would be a second, weaker statement of the same rule that
 * could drift from it.
 */

describe('a rating is a closed union', () => {
	it('does not accept a third value', () => {
		const store = new InMemoryMessageFeedbackStore(acceptAnyMessage)

		// @ts-expect-error — 'meh' is not a FeedbackRating. Widening the union
		// later must be a deliberate major with a migration, and this line is
		// what turns that from an accident into a decision: it stops
		// compiling the moment the union opens up.
		const rating: FeedbackRating = 'meh'

		expect(store).toBeDefined()
		expect(rating).toBe('meh')
	})

	it('accepts the two that exist', async () => {
		const store = new InMemoryMessageFeedbackStore(acceptAnyMessage)
		const runId = 'run_u' as RunId

		for (const [i, rating] of (['good', 'bad'] as const).entries()) {
			const record = await store.putMessageFeedback({
				runId,
				messageId: `msg_${i}` as MessageId,
				rating,
				expectedVersion: 0,
			})
			expect(record.rating).toBe(rating)
		}
	})
})
