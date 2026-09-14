import { describe, expect, it } from 'vitest'
import { normalizeHarnessProtection } from '../harness-protection.js'

describe('protection task admission', () => {
	it('rejects empty, duplicated, overlapping or unbounded selections', () => {
		for (const plan of [
			undefined,
			{ verification: [], confirmation: ['c'] },
			{ verification: ['v'], confirmation: [] },
			{ verification: ['v', 'v'], confirmation: ['c'] },
			{ verification: ['v'], confirmation: ['v'] },
			{ verification: [' v'], confirmation: ['c'] },
			{ verification: Array.from({ length: 64 }, (_, i) => `v${i}`), confirmation: ['c'] },
		])
			expect(() => normalizeHarnessProtection(plan!)).toThrow()
	})
	it('detaches and freezes the declared selection before host callbacks run', () => {
		const input = { verification: ['v'], confirmation: ['c'] }
		const admitted = normalizeHarnessProtection(input)
		input.verification[0] = 'replacement'
		expect(admitted.verification).toEqual(['v'])
		expect(Object.isFrozen(admitted)).toBe(true)
		expect(Object.isFrozen(admitted.confirmation)).toBe(true)
	})
})
