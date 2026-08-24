import { describe, expect, it } from 'vitest'

import { isModelContentOmission } from './index.js'

describe('isModelContentOmission', () => {
	it('accepts the established provider-refusal record', () => {
		expect(isModelContentOmission({ reason: 'provider-rejected' })).toBe(true)
	})

	it('accepts a model-boundary image-admission refusal', () => {
		expect(isModelContentOmission({ reason: 'invalid-image' })).toBe(true)
	})

	it('refuses unknown durable delivery reasons', () => {
		expect(isModelContentOmission({ reason: 'malformed' })).toBe(false)
		expect(isModelContentOmission(null)).toBe(false)
	})
})
