import { describe, expect, it } from 'vitest'

import {
	PROVIDER_TYPES,
	ProfileValidationError,
	isProviderType,
	validateProfile,
} from './schema.js'

describe('isProviderType', () => {
	it('accepts every shipped type', () => {
		for (const t of PROVIDER_TYPES) expect(isProviderType(t)).toBe(true)
	})

	it('rejects unknown types', () => {
		expect(isProviderType('gemini')).toBe(false)
		expect(isProviderType(undefined)).toBe(false)
		expect(isProviderType(42)).toBe(false)
	})
})

describe('validateProfile', () => {
	it('passes a minimal anthropic profile', () => {
		const p = validateProfile({ name: 'work', type: 'anthropic' })
		expect(p.name).toBe('work')
		expect(p.type).toBe('anthropic')
	})

	it('rejects missing name', () => {
		expect(() => validateProfile({ type: 'anthropic' })).toThrow(ProfileValidationError)
	})

	it('rejects unknown type with a helpful message', () => {
		expect(() => validateProfile({ name: 'x', type: 'gpt-5-pro' })).toThrowError(/must be one of/)
	})

	it('rejects non-boolean default', () => {
		expect(() => validateProfile({ name: 'x', type: 'openai', default: 'yes' })).toThrow(
			ProfileValidationError,
		)
	})

	it('requires baseUrl when type=http', () => {
		expect(() => validateProfile({ name: 'h', type: 'http' })).toThrowError(/baseUrl is required/)
		const ok = validateProfile({ name: 'h', type: 'http', baseUrl: 'https://example.com' })
		expect(ok.type).toBe('http')
	})

	it('rejects non-string model', () => {
		expect(() => validateProfile({ name: 'x', type: 'openai', model: 42 })).toThrow(
			ProfileValidationError,
		)
	})

	it('rejects non-object inputs', () => {
		expect(() => validateProfile(null)).toThrow(ProfileValidationError)
		expect(() => validateProfile('string')).toThrow(ProfileValidationError)
		expect(() => validateProfile([])).toThrow(ProfileValidationError)
	})
})
