import { afterEach, describe, expect, it, vi } from 'vitest'

import { readPositiveIntEnv } from '../env.js'

/**
 * `readPositiveIntEnv`'s doc comment makes three promises. This file pins
 * each one so a future edit that breaks one of them fails here rather than
 * being noticed only through a knob that silently stopped tuning.
 */
describe('readPositiveIntEnv', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('parses a positive whole number of milliseconds from the environment', () => {
		vi.stubEnv('NAMZU_TEST_ENV_KEY', '5000')

		expect(readPositiveIntEnv('NAMZU_TEST_ENV_KEY', 1000)).toBe(5000)
	})

	it('falls back to the default rather than parsing, for `soon`, `-1`, or nothing at all', () => {
		vi.stubEnv('NAMZU_TEST_ENV_KEY', 'soon')
		expect(readPositiveIntEnv('NAMZU_TEST_ENV_KEY', 1000)).toBe(1000)

		vi.stubEnv('NAMZU_TEST_ENV_KEY', '-1')
		expect(readPositiveIntEnv('NAMZU_TEST_ENV_KEY', 1000)).toBe(1000)

		vi.stubEnv('NAMZU_TEST_ENV_KEY', undefined)
		expect(readPositiveIntEnv('NAMZU_TEST_ENV_KEY', 1000)).toBe(1000)
	})

	it('falls back to the default when the variable is unset', () => {
		expect(readPositiveIntEnv('NAMZU_TEST_ENV_KEY_UNSET', 42)).toBe(42)
	})
})
