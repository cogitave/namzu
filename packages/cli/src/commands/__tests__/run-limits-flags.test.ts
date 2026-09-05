import { describe, expect, it } from 'vitest'

import { parseRunFlags } from '../run-flags.js'

describe('--max-iterations and --token-budget', () => {
	it('parse whole numbers above zero', () => {
		const flags = parseRunFlags(['--max-iterations', '400', '--token-budget', '5000000', 'go'])
		expect(flags.maxIterations).toBe(400)
		expect(flags.tokenBudget).toBe(5_000_000)
		expect(flags.rest).toEqual(['go'])
	})

	it('are absent by default', () => {
		const flags = parseRunFlags(['go'])
		expect(flags.maxIterations).toBeNull()
		expect(flags.tokenBudget).toBeNull()
	})

	it('refuse anything else, naming the flag', () => {
		expect(() => parseRunFlags(['--max-iterations', '0'])).toThrow(/--max-iterations/)
		expect(() => parseRunFlags(['--token-budget', 'lots'])).toThrow(/--token-budget/)
		expect(() => parseRunFlags(['--max-iterations', '1.5'])).toThrow(/--max-iterations/)
	})
})

describe('--wait-for-provider', () => {
	it('parses a duration into milliseconds', () => {
		expect(parseRunFlags(['--wait-for-provider', '30m', 'go']).waitForProviderMs).toBe(1_800_000)
		expect(parseRunFlags(['--wait-for-provider', '90s']).waitForProviderMs).toBe(90_000)
	})

	it('is absent by default, so the config key decides', () => {
		expect(parseRunFlags(['go']).waitForProviderMs).toBeNull()
	})

	it('refuses a duration it cannot read, naming the flag', () => {
		expect(() => parseRunFlags(['--wait-for-provider', 'a while'])).toThrow(/--wait-for-provider/)
	})
})
