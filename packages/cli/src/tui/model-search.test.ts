import { describe, expect, it } from 'vitest'

import { type ModelChoice, modelStep } from './model-choices.js'
import { filterModelChoices } from './model-search.js'

const choices: readonly ModelChoice[] = [
	{ id: 'Catalogue/Model-A', label: 'Catalogue Model A' },
	{ id: 'vendor/vision', label: 'Vision', note: '(image input)' },
	{ id: 'vendor/legacy', label: 'Legacy', note: '(namzu default)' },
	{ id: 'google/lyria-3-pro-preview', label: 'Google: Lyria 3 Pro Preview', note: '(free)' },
]

describe('filterModelChoices', () => {
	it('matches IDs as it always has', () => {
		expect(filterModelChoices(choices, 'vision').map((choice) => choice.id)).toEqual([
			'vendor/vision',
		])
		// Case is ignored, and NFKC is applied before the comparison.
		expect(filterModelChoices(choices, 'CATALOGUE/MODEL-a').map((choice) => choice.id)).toEqual([
			'Catalogue/Model-A',
		])
		// Every typed word must appear.
		expect(filterModelChoices(choices, 'catalogue model').map((choice) => choice.id)).toEqual([
			'Catalogue/Model-A',
		])
		expect(filterModelChoices(choices, 'catalogue vision')).toEqual([])
	})

	it('matches labels as it always has', () => {
		expect(filterModelChoices(choices, 'lyria 3 pro').map((choice) => choice.id)).toEqual([
			'google/lyria-3-pro-preview',
		])
	})

	it('matches the note, so a word finds a row that never spells it', () => {
		expect(filterModelChoices(choices, 'free').map((choice) => choice.id)).toEqual([
			'google/lyria-3-pro-preview',
		])
		// The same rule reaches the other notes, which is what makes it a rule
		// rather than a special case for one word.
		expect(filterModelChoices(choices, 'image').map((choice) => choice.id)).toEqual([
			'vendor/vision',
		])
		expect(filterModelChoices(choices, 'default').map((choice) => choice.id)).toEqual([
			'vendor/legacy',
		])
	})

	it('retains catalogue order and identity', () => {
		const found = filterModelChoices(choices, 'vendor')
		expect(found.map((choice) => choice.id)).toEqual(['vendor/vision', 'vendor/legacy'])
		// Identity, not equality: the Picker holds a cursor index and a selected
		// ID against this list, so a copy would be a different list to it.
		expect(found[0]).toBe(choices[1])
		expect(found[1]).toBe(choices[2])
	})

	it('returns the list it was given when nothing was typed', () => {
		expect(filterModelChoices(choices, '')).toBe(choices)
		expect(filterModelChoices(choices, '   ')).toBe(choices)
	})

	// Through the real producer rather than a hand-built row, because the point
	// of searching the note is that the note is written somewhere. These are
	// real OpenRouter rows from https://openrouter.ai/api/v1/models (no key),
	// taken on 2026-09-18 and listed in the order that endpoint returned them.
	it('finds a free model whose ID and display name never say so', () => {
		const step = modelStep('claude-sonnet-4-5', {
			kind: 'ok',
			models: [
				// pricing.prompt 0.0000025, pricing.completion 0.0000075
				{ id: 'unbiased/pareto', name: 'Pareto', inputPrice: 2.5, outputPrice: 7.5 },
				{
					id: 'nex-agi/nex-n2.5-mini:free',
					name: 'Nex AGI: Nex-N2.5-Mini (free)',
					inputPrice: 0,
					outputPrice: 0,
				},
				{
					id: 'google/lyria-3-pro-preview',
					name: 'Google: Lyria 3 Pro Preview',
					inputPrice: 0,
					outputPrice: 0,
				},
			],
		})

		// Both zero-priced rows, in catalogue order — the second of them says it
		// only in its note — and neither the paid row nor the default namzu adds
		// to the top of the list.
		expect(filterModelChoices(step.choices, 'free').map((choice) => choice.id)).toEqual([
			'nex-agi/nex-n2.5-mini:free',
			'google/lyria-3-pro-preview',
		])
		expect(filterModelChoices(step.choices, 'lyria').map((choice) => choice.id)).toEqual([
			'google/lyria-3-pro-preview',
		])
		expect(filterModelChoices(step.choices, 'pareto').map((choice) => choice.id)).toEqual([
			'unbiased/pareto',
		])
	})
})
