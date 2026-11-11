import { describe, expect, it } from 'vitest'
import { modelFacts } from './model-facts.js'

describe('modelFacts', () => {
	it('says the window and that a free model is free', () => {
		expect(modelFacts({ contextWindow: 128_000, inputPrice: 0, outputPrice: 0 })).toBe(
			'128k window · Free',
		)
	})
	it('prints both rates per million tokens', () => {
		expect(modelFacts({ contextWindow: 1_000_000, inputPrice: 3, outputPrice: 15 })).toBe(
			'1M window · $3 in · $15 out per 1M',
		)
		expect(modelFacts({ inputPrice: 0.25, outputPrice: 1.25 })).toBe('$0.25 in · $1.25 out per 1M')
	})
	it('leaves out what is not known and never prints a zero as a guess', () => {
		expect(modelFacts({})).toBeUndefined()
		expect(modelFacts({ contextWindow: 32_000 })).toBe('32k window')
		// One rate alone is not a price.
		expect(modelFacts({ inputPrice: 3 })).toBeUndefined()
		expect(modelFacts({ contextWindow: 0 })).toBeUndefined()
	})
})
