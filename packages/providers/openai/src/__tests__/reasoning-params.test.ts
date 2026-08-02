import { describe, expect, it } from 'vitest'

import { isReasoningModel } from '../client.js'

/**
 * Reasoning-family models take `max_completion_tokens` and reject both
 * `max_tokens` and `temperature`. The rejection is a 400, which classifies
 * as `invalid_request` and is therefore not retryable — so sending the
 * wrong pair killed the run on its first turn, every time, for anyone
 * pointing namzu at one of these models with a token cap set. The runtime
 * always sets one.
 */

describe('isReasoningModel', () => {
	it.each(['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini', 'gpt-5', 'gpt-5-mini'])(
		'recognises %s',
		(model) => {
			expect(isReasoningModel(model)).toBe(true)
		},
	)

	it('sees through a deployment or vendor prefix', () => {
		expect(isReasoningModel('openai/gpt-5')).toBe(true)
		expect(isReasoningModel('my-deployment/o3-mini')).toBe(true)
	})

	it('is case-insensitive', () => {
		expect(isReasoningModel('GPT-5')).toBe(true)
	})

	it.each(['gpt-4o', 'gpt-4.1', 'gpt-3.5-turbo', 'chatgpt-4o-latest'])(
		'leaves %s on the standard parameters',
		(model) => {
			expect(isReasoningModel(model)).toBe(false)
		},
	)

	it('falls through for an unknown model rather than guessing', () => {
		// Conservative on purpose. A false positive strips `temperature`
		// from a model that honours it, which is a silent behaviour change;
		// a false negative produces a clear 400 naming the parameter.
		expect(isReasoningModel('some-new-model-v2')).toBe(false)
		expect(isReasoningModel('llama-3.1-70b')).toBe(false)
	})

	it('does not match a model that merely contains the prefix later on', () => {
		expect(isReasoningModel('custom-o1-clone')).toBe(false)
	})
})
