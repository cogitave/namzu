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
