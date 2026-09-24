/**
 * Which option a question recommends, and the labels its options are shown
 * and answered under (issue #535).
 *
 * The recommendation used to live only in the label, as an English
 * " (Recommended)" the tool stripped; a model answering in the user's language
 * wrote "(Önerilen)" or "(Empfohlen)", and that reached the screen and the
 * answer. These pin the structured flag, the marker removal in any language,
 * and the qualifiers that must survive it.
 */

import { describe, expect, it } from 'vitest'

import { questionOptions } from '../question-options.js'

const labels = (options: ReturnType<typeof questionOptions>) => options.map((o) => o.label)
const recommended = (options: ReturnType<typeof questionOptions>) =>
	options.filter((o) => o.recommended === true).map((o) => o.id)

describe('questionOptions', () => {
	it('numbers the options and carries the flag the model set, only where it is true', () => {
		const options = questionOptions([
			{ label: 'Board', description: 'Executive framing', recommended: true },
			{ label: 'Engineers', recommended: false },
			{ label: 'Customers' },
		])
		expect(options).toEqual([
			{ id: 'opt_1', label: 'Board', description: 'Executive framing', recommended: true },
			{ id: 'opt_2', label: 'Engineers' },
			{ id: 'opt_3', label: 'Customers' },
		])
	})

	it('leaves a question with no recommendation alone', () => {
		const options = questionOptions([{ label: 'Board' }, { label: 'Engineers' }])
		expect(options).toEqual([
			{ id: 'opt_1', label: 'Board' },
			{ id: 'opt_2', label: 'Engineers' },
		])
	})

	it.each([['Board (Recommended)'], ['Board (recommended)'], ['Board  (RECOMMENDED)  ']])(
		'reads the English marker %j as a recommendation on any option',
		(label) => {
			const options = questionOptions([{ label: 'Engineers' }, { label }])
			expect(labels(options)).toEqual(['Engineers', 'Board'])
			expect(recommended(options)).toEqual(['opt_2'])
		},
	)

	it.each([
		['Board (Önerilen)'],
		['Board (Empfohlen)'],
		['Board (Recommandé)'],
		['Board (Рекомендуется)'],
		['Board (推荐)'],
		['Board（推荐）'],
		['Board (おすすめ)'],
		['Board (권장)'],
		['Board (अनुशंसित)'],
		['Board (موصى به)'],
		['Board (Tavsiye edilen)'],
	])('takes the localised marker out of %j on the option the model flagged', (label) => {
		const options = questionOptions([
			{ label, recommended: true },
			{ label: 'Engineers' },
			{ label: 'Customers' },
		])
		expect(labels(options)).toEqual(['Board', 'Engineers', 'Customers'])
		expect(recommended(options)).toEqual(['opt_1'])
	})

	it('finds the flagged option wherever it is, not only first', () => {
		const options = questionOptions([
			{ label: 'Engineers' },
			{ label: 'Board (Önerilen)', recommended: true },
		])
		expect(labels(options)).toEqual(['Engineers', 'Board'])
		expect(recommended(options)).toEqual(['opt_2'])
	})

	it('takes the marker off every flagged option of a multi-select', () => {
		const options = questionOptions([
			{ label: 'Lint (Empfohlen)', recommended: true },
			{ label: 'Tests (Empfohlen)', recommended: true },
			{ label: 'Benchmarks' },
		])
		expect(labels(options)).toEqual(['Lint', 'Tests', 'Benchmarks'])
		expect(recommended(options)).toEqual(['opt_1', 'opt_2'])
	})

	it.each([
		['with the flag left out', {}],
		['with recommended: false', { recommended: false }],
	])('keeps the qualifier of an unflagged first option and recommends nothing, %s', (_, flag) => {
		// Recommending is optional, so a first option the model did not flag
		// is not a recommendation, and its trailing group is a qualifier.
		for (const label of [
			'Cloud (AWS)',
			'Tabs (current)',
			'Use cache (Redis)',
			'Kurul (Önerilen)',
		]) {
			const options = questionOptions([
				{ label, ...flag },
				{ label: 'On-premises', ...flag },
			])
			expect(options).toEqual([
				{ id: 'opt_1', label },
				{ id: 'opt_2', label: 'On-premises' },
			])
		}
	})

	it('never overrides an explicit recommended: false, not even for an English marker', () => {
		const options = questionOptions([
			{ label: 'Board (Recommended)', recommended: false },
			{ label: 'Engineers (Empfohlen) (Recommended)', recommended: false },
			{ label: 'Customers' },
		])
		// "(Recommended)" is never part of a name, so it still comes off; the
		// flag the model set is what says whether the option is recommended.
		expect(options).toEqual([
			{ id: 'opt_1', label: 'Board' },
			{ id: 'opt_2', label: 'Engineers (Empfohlen)' },
			{ id: 'opt_3', label: 'Customers' },
		])
	})

	it('reads a trailing group only on the option flagged true, when another is explicitly false', () => {
		const options = questionOptions([
			{ label: 'Cloud (Önerilen)', recommended: true },
			{ label: 'On-premises', recommended: false },
		])
		expect(options).toEqual([
			{ id: 'opt_1', label: 'Cloud', recommended: true },
			{ id: 'opt_2', label: 'On-premises' },
		])
	})

	it('removes both a localised and an English marker from one label', () => {
		const options = questionOptions([
			{ label: 'Kurul (Önerilen) (Recommended)' },
			{ label: 'Mühendisler' },
		])
		expect(labels(options)).toEqual(['Kurul', 'Mühendisler'])
		expect(recommended(options)).toEqual(['opt_1'])
	})

	it('keeps a qualifier the options share: it names them, it does not recommend one', () => {
		const options = questionOptions([
			{ label: 'Postgres (managed)', recommended: true },
			{ label: 'Postgres (self-hosted)' },
		])
		expect(labels(options)).toEqual(['Postgres (managed)', 'Postgres (self-hosted)'])
		expect(recommended(options)).toEqual(['opt_1'])
	})

	it('keeps a qualifier that is all that tells two options apart', () => {
		const options = questionOptions([
			{ label: 'Postgres (managed)', recommended: true },
			{ label: 'Postgres' },
		])
		expect(labels(options)).toEqual(['Postgres (managed)', 'Postgres'])
	})

	it.each([
		['Upgrade (v2)'],
		['Short (~5 min)'],
		['Cheap ($10/mo)'],
		['Split (e.g. by team)'],
		['Keep all four words (one two three four)'],
	])('keeps %j: a group with digits, symbols or four words is not a marker', (label) => {
		const options = questionOptions([{ label, recommended: true }, { label: 'Other' }])
		expect(labels(options)).toEqual([label, 'Other'])
	})

	it('keeps a group on a later unflagged option too', () => {
		const options = questionOptions([{ label: 'Board' }, { label: 'Engineers (Önerilen)' }])
		expect(labels(options)).toEqual(['Board', 'Engineers (Önerilen)'])
		expect(recommended(options)).toEqual([])
	})

	it('trims a label, as the answer always quoted it', () => {
		const options = questionOptions([{ label: '  Board ' }, { label: 'Engineers' }])
		expect(labels(options)).toEqual(['Board', 'Engineers'])
	})

	it('keeps a label that is nothing but a group', () => {
		const options = questionOptions([{ label: '(Önerilen)' }, { label: 'Other' }])
		expect(labels(options)).toEqual(['(Önerilen)', 'Other'])
		expect(recommended(options)).toEqual([])
	})
})
