import { describe, expect, it } from 'vitest'
import { refineEvidenceRecallTerms } from '../evidence-recall.js'

describe('bounded evidence query refinement', () => {
	it('focuses on uncovered terms while preserving source spelling and order', () => {
		const terms = Object.freeze(['in', 'DELTA', 'original'])
		const excerpts = Object.freeze(['One item is IN queue 1', 'Another item is in queue 2'])
		expect(refineEvidenceRecallTerms(terms, excerpts)).toEqual(['DELTA', 'original'])
		expect(terms).toEqual(['in', 'DELTA', 'original'])
		expect(excerpts).toHaveLength(2)
	})

	it('uses complete Unicode tokens without stripping numeric or identifier terms', () => {
		expect(
			refineEvidenceRecallTerms(['in', '3', 'id_1', 'İZMİR'], ['in 13000 id_100 İZMİRLİ']),
		).toEqual(['3', 'id_1', 'İZMİR'])
		expect(refineEvidenceRecallTerms(['İZMİR', 'Delta'], ['İzmİr'])).toEqual(['Delta'])
		expect(refineEvidenceRecallTerms(['İZMİR', 'Delta'], ['izmir'])).toBeUndefined()
	})

	it('does not let case variants or repeated excerpts manufacture uncovered terms', () => {
		expect(refineEvidenceRecallTerms(['In', 'IN', 'DELTA', 'delta'], ['in', 'in'])).toEqual([
			'DELTA',
		])
		expect(refineEvidenceRecallTerms(['In', 'IN'], ['in'])).toBeUndefined()
	})

	it.each([
		{ terms: ['in', 'DELTA'], excerpts: [] },
		{ terms: ['in', 'DELTA'], excerpts: ['Packing information'] },
		{ terms: ['in', 'DELTA'], excerpts: ['DELTA is in the receipt'] },
		{ terms: ['DELTA'], excerpts: ['DELTA'] },
		{ terms: ['DELTA'], excerpts: ['unrelated'] },
	])('does not restart an unchanged or exhausted query: $excerpts', ({ terms, excerpts }) => {
		expect(refineEvidenceRecallTerms(terms, excerpts)).toBeUndefined()
	})

	it.each([[], [''], ['two words'], ['a-b'], ['x'.repeat(257)], Array(17).fill('x'), [null]])(
		'rejects invalid query terms %j',
		(terms) => {
			expect(() => refineEvidenceRecallTerms(terms as string[], [])).toThrow('single-token terms')
		},
	)

	it.each([['x'.repeat(513)], Array(25).fill('x'), [null]])(
		'rejects invalid excerpts %j',
		(excerpts) => {
			expect(() => refineEvidenceRecallTerms(['x'], excerpts as string[])).toThrow(
				'bounded excerpts',
			)
		},
	)
})
