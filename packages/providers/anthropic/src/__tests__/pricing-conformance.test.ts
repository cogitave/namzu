import { resolveModelPricing } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OFFLINE_MODEL_CATALOGUE } from '../client.js'

/**
 * Every model this driver offers has a price.
 *
 * This is the check the price catalogue's own regeneration gate cannot be.
 * `scripts/generate-model-prices.mjs --check` proves the generated module is
 * exactly what its source produces — which says nothing about whether the KEYS
 * in it match the model ids a driver actually reports. A catalogue holding
 * `claude-sonnet-4-5` while the driver offers `claude-sonnet-4-5-20250929` is
 * internally consistent, regenerates cleanly, and prices nothing.
 *
 * That failure is invisible at run time too: an unmatched key is
 * indistinguishable from a model genuinely nobody has a rate for, so it
 * surfaces as `unpricedTokens` — or, with a `costLimitUsd`, as a refused run —
 * with no hint that the rate exists and the lookup missed it.
 *
 * It was not hypothetical. When this test was written, two of the three models
 * on the menu below resolved to nothing.
 *
 * Only a driver package can ask this: the SDK must not import a provider
 * (`sdk ← providers`, never the reverse), so the SDK's own tests cannot reach
 * a real driver's model list. A new driver inherits the obligation, not the
 * test — copy it.
 */
describe('the offline menu and the price catalogue agree', () => {
	it.each(OFFLINE_MODEL_CATALOGUE.map((model) => model.id))('%s has a rate', (id) => {
		expect(resolveModelPricing('anthropic', id)).toBeDefined()
	})

	it('agrees with the driver on what those models cost', () => {
		// The menu carries the vendor's own published rates, entered
		// independently of `rates.source.json`. Two hand-maintained copies of
		// the same fact drift, and this is where that shows up — an id that
		// resolves to the wrong row passes the existence check above and fails
		// here.
		for (const model of OFFLINE_MODEL_CATALOGUE) {
			const pricing = resolveModelPricing('anthropic', model.id)
			expect(pricing?.inputCostPer1M, `${model.id} input`).toBe(model.inputPrice)
			expect(pricing?.outputCostPer1M, `${model.id} output`).toBe(model.outputPrice)
		}
	})

	it('still reports nothing for a model the menu does not offer', () => {
		// Guards the test above from passing for the wrong reason: a resolver
		// that returned a rate for everything would satisfy every case here.
		expect(resolveModelPricing('anthropic', 'claude-not-a-real-model')).toBeUndefined()
	})
})
