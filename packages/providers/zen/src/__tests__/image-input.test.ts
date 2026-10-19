import { describe, expect, it } from 'vitest'
import { ZenProvider } from '../client.js'
import { getZenModels } from '../models.js'

describe('Zen image input per model', () => {
	const provider = new ZenProvider({ apiKey: 'test-key' })
	const models = getZenModels('zen')

	it('answers from the catalogue, model by model', () => {
		const textOnly = models.find((m) => m.inputModalities && !m.inputModalities.includes('image'))
		const vision = models.find((m) => m.inputModalities?.includes('image'))
		expect(textOnly).toBeDefined()
		expect(vision).toBeDefined()
		expect(provider.supportsImageInputFor(textOnly?.id ?? '')).toBe(false)
		expect(provider.supportsImageInputFor(vision?.id ?? '')).toBe(true)
	})

	it('assumes a model the catalogue does not know reads images', () => {
		expect(provider.supportsImageInputFor('not-a-listed-model')).toBe(true)
	})

	it('still declares the driver itself as image capable', () => {
		expect(provider.capabilities.supportsVision).toBe(true)
	})
})
