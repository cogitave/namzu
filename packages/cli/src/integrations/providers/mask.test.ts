import { describe, expect, it } from 'vitest'

import { maskSecret } from './mask.js'

describe('maskSecret', () => {
	it('returns null for null / undefined / empty', () => {
		expect(maskSecret(null)).toBeNull()
		expect(maskSecret(undefined)).toBeNull()
		expect(maskSecret('')).toBeNull()
	})

	it('returns *** for secrets shorter than the keep window', () => {
		expect(maskSecret('abc', 4)).toBe('***')
		expect(maskSecret('abcd', 4)).toBe('***')
	})

	it('keeps the last N characters by default', () => {
		expect(maskSecret('sk-ant-deadbeef1234')).toBe('***1234')
	})

	it('honors a custom keep length', () => {
		expect(maskSecret('sk-ant-deadbeef1234', 6)).toBe('***ef1234')
	})
})
