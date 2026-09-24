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

import { afterEach, describe, expect, it, vi } from 'vitest'

import { foldForComparison, questionOptions } from '../question-options.js'

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
			{ label: 'Tests (empfohlen)', recommended: true },
			{ label: 'Benchmarks' },
		])
		expect(labels(options)).toEqual(['Lint', 'Tests', 'Benchmarks'])
		expect(recommended(options)).toEqual(['opt_1', 'opt_2'])
	})

	it.each([
		[['Tests (unit)', 'Tests (e2e)']],
		[['Tests (e2e)', 'Tests (unit)']],
		[['Postgres (managed)', 'Postgres (self-hosted)']],
		[['Postgres (self-hosted)', 'Postgres (managed)']],
		[['Cloud (AWS)', 'Cache (Redis)']],
	])('keeps the groups two flagged options differ in, %j', (flagged) => {
		// A marker is the same word on every option the model recommends; a
		// group that differs between them is what the options are.
		const options = questionOptions([
			...flagged.map((label) => ({ label, recommended: true })),
			{ label: 'Lint' },
		])
		expect(labels(options)).toEqual([...flagged, 'Lint'])
		expect(recommended(options)).toEqual(['opt_1', 'opt_2'])
	})

	it('keeps two different localised markers that are all that tells two flagged options apart', () => {
		for (const flagged of [
			['Redis (Önerilen)', 'Redis (Empfohlen)'],
			['Redis (Empfohlen)', 'Redis (Önerilen)'],
		]) {
			const options = questionOptions(flagged.map((label) => ({ label, recommended: true })))
			expect(labels(options)).toEqual(flagged)
		}
	})

	it('keeps the marker only where removing it would repeat another label', () => {
		const options = questionOptions([
			{ label: 'Redis (Empfohlen)', recommended: true },
			{ label: 'Postgres (Empfohlen)', recommended: true },
			{ label: 'Redis' },
		])
		expect(labels(options)).toEqual(['Redis (Empfohlen)', 'Postgres', 'Redis'])
		expect(recommended(options)).toEqual(['opt_1', 'opt_2'])
	})

	it('gives every option the same label whatever order the options come in', () => {
		const questions: Parameters<typeof questionOptions>[0][] = [
			[
				{ label: 'Tests (unit)', recommended: true },
				{ label: 'Tests (e2e)', recommended: true },
				{ label: 'Lint' },
			],
			[
				{ label: 'Redis (Önerilen)', recommended: true },
				{ label: 'Redis (Empfohlen)', recommended: true },
				{ label: 'Postgres' },
			],
			[
				{ label: 'Redis (Empfohlen)', recommended: true },
				{ label: 'Postgres (Empfohlen)', recommended: true },
				{ label: 'Redis' },
			],
			[
				{ label: 'Lint (Empfohlen)', recommended: true },
				{ label: 'Tests (Empfohlen)', recommended: true },
				{ label: 'Tests' },
				{ label: 'Benchmarks (Recommended)' },
			],
			[
				{ label: 'Board (Önerilen)', recommended: true },
				{ label: 'Board' },
				{ label: 'Engineers (Önerilen)', recommended: true },
			],
			[
				{ label: 'Cloud (AWS) (Recommended)' },
				{ label: 'Edge (Empfohlen)', recommended: true },
				{ label: 'On-premises' },
			],
		]
		for (const question of questions) {
			const expected = new Map(
				question.map((option, index) => [option, questionOptions(question)[index]?.label]),
			)
			for (const order of permutations(question)) {
				const shown = labels(questionOptions(order))
				expect(shown).toEqual(order.map((option) => expected.get(option)))
			}
		}
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

	it('recommends only by the flag or, without one, by "(Recommended)", and changes nothing else', () => {
		// What the host is told: an option is recommended when the model set
		// `recommended: true`, or left the flag out and wrote "(Recommended)";
		// an option that is not recommended loses only surrounding spaces and a
		// trailing "(Recommended)".
		const options = questionOptions([
			{ label: ' Cloud (AWS) ' },
			{ label: 'On-premises (Recommended)' },
			{ label: 'Hybrid (Önerilen)' },
			{ label: 'Edge (Recommended)', recommended: false },
		])
		expect(options).toEqual([
			{ id: 'opt_1', label: 'Cloud (AWS)' },
			{ id: 'opt_2', label: 'On-premises', recommended: true },
			{ id: 'opt_3', label: 'Hybrid (Önerilen)' },
			{ id: 'opt_4', label: 'Edge' },
		])
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

	it.each([
		['Cloud (AWS) (Recommended)', 'Cloud (AWS)'],
		['Tests (unit) (Recommended)', 'Tests (unit)'],
		['Cache（Redis）(Recommended)', 'Cache（Redis）'],
		['Kurul (Önerilen) (Recommended)', 'Kurul (Önerilen)'],
	])('keeps the group left in %j once "(Recommended)" comes off', (label, clean) => {
		// The old instruction was to append " (Recommended)" to the name, so
		// what is left before it is the name, qualifier and all.
		for (const flag of [{}, { recommended: true }]) {
			const options = questionOptions([{ label, ...flag }, { label: 'On-premises' }])
			expect(labels(options)).toEqual([clean, 'On-premises'])
			expect(recommended(options)).toEqual(['opt_1'])
		}
	})

	it('keeps every group when one option\'s group is left from "(Recommended)"', () => {
		// That group is a qualifier, and like an unflagged option's it says the
		// groups in this question name the options.
		for (const question of [
			[{ label: 'Lint (Empfohlen)', recommended: true }, { label: 'Tests (unit) (Recommended)' }],
			[
				{ label: 'Kurul (Önerilen) (Recommended)' },
				{ label: 'Mühendisler (Önerilen)', recommended: true },
			],
		]) {
			for (const order of permutations(question)) {
				const shown = labels(questionOptions(order))
				expect(shown).toEqual(order.map((option) => option.label.replace(/ \(Recommended\)$/u, '')))
			}
		}
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

describe('comparing labels, the same on every host', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it.each([
		['ÖNERİLEN', 'Önerilen'],
		['KURUL', 'kurul'],
		['TAVSİYE EDİLEN', 'Tavsiye edilen'],
		['TAVSIYE EDILEN', 'tavsiye edilen'],
		['ı', 'i'],
		['I', 'i'],
		['İ', 'i'],
		['i\u0307', 'i'],
		['I\u0307', 'i'],
		['STRASSE', 'Straße'],
		['ẞ', 'ß'],
		['O\u0308nerilen', 'Önerilen'],
		['Tavsiye   edilen', 'tavsiye edilen'],
	])('counts %j and %j as the same text', (a, b) => {
		expect(foldForComparison(a)).toBe(foldForComparison(b))
	})

	it.each([
		['Önerilen', 'Empfohlen'],
		['o', 'ö'],
		['Kurul', 'Kurullar'],
	])('keeps %j and %j apart', (a, b) => {
		expect(foldForComparison(a)).not.toBe(foldForComparison(b))
	})

	it('takes a marker off two flagged options that differ only in Turkish letter case', () => {
		// "İ" lowercases to "i" plus a combining dot everywhere but a Turkish
		// host, so a comparison that followed the host's locale would keep
		// both markers on one host and remove both on the other.
		for (const flagged of [
			['Lint (ÖNERİLEN)', 'Tests (Önerilen)'],
			['Lint (TAVSİYE EDİLEN)', 'Tests (Tavsiye edilen)'],
		]) {
			const options = questionOptions([
				...flagged.map((label) => ({ label, recommended: true })),
				{ label: 'Benchmarks' },
			])
			expect(labels(options)).toEqual(['Lint', 'Tests', 'Benchmarks'])
		}
	})

	it('keeps a marker whose removal would repeat a label that differs only in Turkish letter case', () => {
		const options = questionOptions([
			{ label: 'İZMİR (Önerilen)', recommended: true },
			{ label: 'Ankara (Önerilen)', recommended: true },
			{ label: 'İzmir' },
		])
		expect(labels(options)).toEqual(['İZMİR (Önerilen)', 'Ankara', 'İzmir'])
	})

	it('gives the same labels when the host locale is Turkish', () => {
		// A Turkish default lowercases "I" to "ı" and "İ" to "i"; the process
		// running this suite has whatever locale its host has. Forcing the
		// Turkish mapping onto a locale-less `toLocaleLowerCase()` shows that
		// nothing here depends on it. The proc suite runs the same questions
		// in real processes under LC_ALL=tr_TR.UTF-8 and LC_ALL=C.
		const questions: Parameters<typeof questionOptions>[0][] = [
			[
				{ label: 'Lint (ÖNERİLEN)', recommended: true },
				{ label: 'Tests (Önerilen)', recommended: true },
			],
			[
				{ label: 'Lint (TAVSIYE EDİLEN)', recommended: true },
				{ label: 'Tests (Tavsiye edilen)', recommended: true },
			],
			[
				{ label: 'İZMİR (Önerilen)', recommended: true },
				{ label: 'Ankara (Önerilen)', recommended: true },
				{ label: 'İzmir' },
			],
			[{ label: 'KIRMIZI (Önerilen)', recommended: true }, { label: 'kırmızı' }],
		]
		const asHostIs = questions.map((question) => labels(questionOptions(question)))

		const lower = String.prototype.toLocaleLowerCase
		vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
			this: string,
			locales?: Intl.LocalesArgument,
		) {
			return lower.call(this, locales ?? 'tr')
		})
		const asTurkish = questions.map((question) => labels(questionOptions(question)))

		expect(asTurkish).toEqual(asHostIs)
		expect(asHostIs).toEqual([
			['Lint', 'Tests'],
			['Lint', 'Tests'],
			['İZMİR (Önerilen)', 'Ankara', 'İzmir'],
			['KIRMIZI (Önerilen)', 'kırmızı'],
		])
	})
})

function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) return [[...items]]
	return items.flatMap((item, index) =>
		permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
			item,
			...rest,
		]),
	)
}
