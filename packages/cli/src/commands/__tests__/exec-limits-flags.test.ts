import { describe, expect, it } from 'vitest'

import { parseExecFlags } from '../exec-flags.js'

describe('--max-iterations and --token-budget', () => {
	it('parse whole numbers above zero', () => {
		const flags = parseExecFlags(['--max-iterations', '400', '--token-budget', '5000000', 'go'])
		expect(flags.maxIterations).toBe(400)
		expect(flags.tokenBudget).toBe(5_000_000)
		expect(flags.rest).toEqual(['go'])
	})

	it('are absent by default', () => {
		const flags = parseExecFlags(['go'])
		expect(flags.maxIterations).toBeNull()
		expect(flags.tokenBudget).toBeNull()
	})

	it('refuse anything else, naming the flag', () => {
		expect(() => parseExecFlags(['--max-iterations', '-1'])).toThrow(/--max-iterations/)
		expect(() => parseExecFlags(['--token-budget', 'lots'])).toThrow(/--token-budget/)
		expect(() => parseExecFlags(['--max-iterations', '1.5'])).toThrow(/--max-iterations/)
	})
	it('accepts explicit zero without treating it as an absent override', () => {
		expect(parseExecFlags(['--max-iterations=0', '--token-budget', '0', 'go'])).toMatchObject({
			maxIterations: 0,
			tokenBudget: 0,
			rest: ['go'],
		})
	})
	it.each(['', ' ', '-1', '0.5', 'Infinity', '9007199254740992'])(
		'rejects invalid unlimited spellings and unsafe amounts: %j',
		(value) => {
			for (const flag of ['--max-iterations', '--token-budget']) {
				expect(() => parseExecFlags([`${flag}=${value}`])).toThrow(flag)
			}
		},
	)
})

describe('--wait-for-provider', () => {
	it('parses a duration into milliseconds', () => {
		expect(parseExecFlags(['--wait-for-provider', '30m', 'go']).waitForProviderMs).toBe(1_800_000)
		expect(parseExecFlags(['--wait-for-provider', '90s']).waitForProviderMs).toBe(90_000)
	})

	it('is absent by default, so the config key decides', () => {
		expect(parseExecFlags(['go']).waitForProviderMs).toBeNull()
	})

	it('refuses a duration it cannot read, naming the flag', () => {
		expect(() => parseExecFlags(['--wait-for-provider', 'a while'])).toThrow(/--wait-for-provider/)
	})
})

describe('--effort', () => {
	it('preserves an explicit low effort and keeps it out of the prompt', () => {
		const flags = parseExecFlags(['--effort', 'low', 'go'])
		expect(flags.effort).toBe('low')
		expect(flags.rest).toEqual(['go'])
		expect(parseExecFlags(['--effort=medium']).effort).toBe('medium')
		expect(parseExecFlags(['go']).effort).toBeNull()
	})
	it('rejects invalid levels without silently using a provider default', () => {
		expect(() => parseExecFlags(['--effort', 'cheap'])).toThrow(/--effort/)
		expect(() => parseExecFlags(['--effort='])).toThrow(/--effort/)
	})
})
