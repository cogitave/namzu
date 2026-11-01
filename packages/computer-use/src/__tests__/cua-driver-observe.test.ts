import { describe, expect, it } from 'vitest'
import {
	type Observation,
	changeBetween,
	foldText,
	judgeObserved,
	sameObservation,
} from '../adapters/cua-driver/observe.js'

const SEP = '\u0000'
const seen = (...texts: [role: string, text: string][]): Observation => {
	const out = new Map<string, number>()
	for (const [role, text] of texts) {
		const key = `${role}${SEP}${text}`
		out.set(key, (out.get(key) ?? 0) + 1)
	}
	return out
}

describe('verifying an input by what the window shows', () => {
	it('verifies typed text that now appears, whatever its case, spacing or operator glyphs', () => {
		const before = seen(['Text', 'Expression is'], ['Text', 'Display is 0'])
		const after = seen(['Text', 'Expression is 7 × 6='], ['Text', 'Display is 42'])
		const verdict = judgeObserved({ typed: '7*6=' }, { before, after })
		expect(verdict).toMatchObject({
			delivery: 'delivered_verified',
			retrySafety: 'unsafe',
			observed: 'Expression is 7 × 6=',
		})
	})

	it('does not verify typed text from a change that does not show it', () => {
		const before = seen(['Text', 'Clock 10:01'])
		const after = seen(['Text', 'Clock 10:02'])
		expect(judgeObserved({ typed: 'hello' }, { before, after })).toBeUndefined()
	})

	it('verifies a press by a change that held still and was not there before', () => {
		const before = seen(['Text', 'none'])
		const after = seen(['Text', 'submitted 1'])
		const verdict = judgeObserved({}, { before, after, earlier: before, later: after })
		expect(verdict).toMatchObject({ delivery: 'delivered_verified', observed: 'submitted 1' })
		expect(verdict?.detail).toMatch(/none/)
	})

	it('does not verify a press when nothing changed', () => {
		const same = seen(['Text', 'none'])
		expect(judgeObserved({}, { before: same, after: same })).toBeUndefined()
	})

	it('does not verify a press in a window that was changing by itself', () => {
		const before = seen(['Text', '10:01'])
		const after = seen(['Text', '10:02'])
		expect(judgeObserved({}, { before, after, earlier: seen(['Text', '10:00']) })).toBeUndefined()
		expect(judgeObserved({}, { before, after, later: seen(['Text', '10:03']) })).toBeUndefined()
	})

	it('counts repeated texts, so a second identical line is a change', () => {
		const before = seen(['Text', 'row'])
		const after = seen(['Text', 'row'], ['Text', 'row'])
		expect(changeBetween(before, after).added).toEqual(['row'])
		expect(sameObservation(before, after)).toBe(false)
	})

	it('folds case, spaces and operator glyphs', () => {
		expect(foldText('7 * 6 =')).toBe(foldText('7×6='))
		expect(foldText('A / B')).toBe(foldText('a÷b'))
	})
})
