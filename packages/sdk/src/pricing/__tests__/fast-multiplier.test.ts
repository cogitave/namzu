import { describe, expect, it } from 'vitest'

import { resolveModelPricing } from '../index.js'

describe('fast-mode multipliers in the catalogue', () => {
	it.each([
		'claude-opus-5-5',
		'claude-fable-5-2',
		'claude-mythos-5-2',
		'claude-opus-5',
		'claude-opus-4-8',
	])('%s carries the published 2x', (model) => {
		expect(resolveModelPricing('anthropic', model)?.fastMultiplier).toBe(2)
	})

	it.each(['claude-opus-4-7', 'claude-sonnet-5-5', 'claude-fable-5-1'])(
		'%s has none, so fast usage on it is unpriced',
		(model) => {
			expect(resolveModelPricing('anthropic', model)?.fastMultiplier).toBeUndefined()
		},
	)
})
