import { describe, expect, it } from 'vitest'

import { VENDOR_RATES } from '../catalogue.generated.js'
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

describe('every fast-mode multiplier the catalogue carries', () => {
	it('is on exactly these models, with exactly these values', () => {
		const wanted = new Map<string, number>([
			['anthropic/claude-opus-5-5', 2],
			['anthropic/claude-fable-5-2', 2],
			['anthropic/claude-mythos-5-2', 2],
			['anthropic/claude-opus-5', 2],
			['anthropic/claude-opus-4-8', 2],
			['openai/gpt-5.4', 2],
			['openai/gpt-5.4-mini', 2],
			['openai/gpt-5.5', 2.5],
			['openai/gpt-5.6-sol', 2],
			['openai/gpt-5.6-terra', 2],
			['openai/gpt-5.6-luna', 2],
		])
		const seen = new Map<string, number>()
		for (const vendor of VENDOR_RATES) {
			for (const [id, pricing] of vendor.models) {
				if (pricing.fastMultiplier !== undefined) {
					seen.set(`${vendor.providerId}/${id}`, pricing.fastMultiplier)
				}
			}
		}
		expect(seen).toEqual(wanted)
	})

	it.each(['gpt-5.4-nano', 'gpt-5.2', 'gpt-5'])('%s has none on the OpenAI side', (model) => {
		expect(resolveModelPricing('openai', model)?.fastMultiplier).toBeUndefined()
	})
})
