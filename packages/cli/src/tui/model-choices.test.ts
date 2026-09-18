import { describe, expect, it } from 'vitest'
import { canSelectModel } from '../integrations/providers/access.js'
import { PROVIDER_REGISTRY } from '../integrations/providers/registry.js'

import { modelStep } from './model-choices.js'

const DEFAULT = 'claude-sonnet-4-5'

it.each([undefined, 'public'])(
	'never reintroduces paid current pins into anonymous Zen choices (%s)',
	(apiKey) => {
		const entry = PROVIDER_REGISTRY.zen
		const allowModel = (model: string) => canSelectModel(entry, apiKey, model)
		for (const listing of [
			{ kind: 'ok', models: [{ id: 'glm-5.3-flash', name: 'Paid GLM' }] },
			{ kind: 'timeout' },
			{ kind: 'failed', reason: 'offline' },
		] as const) {
			const step = modelStep(entry.defaultModel, listing, 'glm-5.3-flash', {
				allowModel,
			})
			expect(step.choices.map((choice) => choice.id)).toEqual([entry.defaultModel])
		}
	},
)

it('retains a paid current Zen pin when an account credential is present', () => {
	const entry = PROVIDER_REGISTRY.zen
	const step = modelStep(entry.defaultModel, { kind: 'timeout' }, 'glm-5.3-flash', {
		allowModel: (model) => canSelectModel(entry, 'account-key', model),
	})
	expect(step.choices.map((choice) => choice.id)).toContain('glm-5.3-flash')
})

describe('modelStep', () => {
	it('offers the listed models', () => {
		const step = modelStep(DEFAULT, {
			kind: 'ok',
			models: [
				{ id: 'a', name: 'Model A' },
				{ id: 'b', name: 'Model B' },
			],
		})
		expect(step.choices.map((c) => c.id)).toEqual([DEFAULT, 'a', 'b'])
		expect(step.notice).toBeNull()
	})

	it('marks the default and does not duplicate it', () => {
		const step = modelStep(DEFAULT, {
			kind: 'ok',
			models: [
				{ id: 'a', name: 'Model A' },
				{ id: DEFAULT, name: 'The Default' },
			],
		})
		expect(step.choices.map((c) => c.id)).toEqual(['a', DEFAULT])
		// Says whose default it is. `(default)` read as the provider's
		// recommendation, which it never was — namzu picks this value, it goes
		// stale between provider releases, and an operator choosing from this
		// list deserves to know it is a choice rather than an endorsement.
		expect(step.choices.find((c) => c.id === DEFAULT)?.note).toBe('(namzu default)')
		expect(step.choices.filter((c) => c.id === DEFAULT)).toHaveLength(1)
	})

	it('labels image input only when the model listing establishes it', () => {
		const step = modelStep(DEFAULT, {
			kind: 'ok',
			models: [
				{ id: 'text', name: 'Text', inputModalities: ['text'] },
				{ id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] },
				{ id: 'unknown', name: 'Unknown' },
			],
		})

		expect(step.choices.find((choice) => choice.id === 'vision')?.note).toBe('(image input)')
		expect(step.choices.find((choice) => choice.id === 'text')?.note).toBeUndefined()
		expect(step.choices.find((choice) => choice.id === 'unknown')?.note).toBeUndefined()
	})

	// The read that found the defect. Every driver wrote `0` for a rate it
	// never learned, so on four of them a rule reading "both prices are zero"
	// labelled the whole menu free — a claim about a bill, printed as a fact,
	// on a screen the operator has no reason to doubt.
	describe('the free marker', () => {
		it('marks a model the provider reported at zero', () => {
			const step = modelStep(DEFAULT, {
				kind: 'ok',
				models: [{ id: 'free', name: 'Free', inputPrice: 0, outputPrice: 0 }],
			})

			expect(step.choices.find((choice) => choice.id === 'free')?.note).toBe('(free)')
		})

		it('says nothing about a model whose rate nobody published', () => {
			// The regression this whole change exists to prevent. Absence is
			// not a price of zero; marking an unknown as free is worse than
			// marking nothing, because it is a quote.
			const step = modelStep(DEFAULT, {
				kind: 'ok',
				models: [{ id: 'unpriced', name: 'Unpriced' }],
			})

			expect(step.choices.find((choice) => choice.id === 'unpriced')?.note).toBeUndefined()
		})

		it('does not mark a half-known rate free', () => {
			// One rate published and not the other is not enough to call a
			// model free, and the strict comparison is what says so.
			const step = modelStep(DEFAULT, {
				kind: 'ok',
				models: [
					{ id: 'half', name: 'Half', inputPrice: 0 },
					{ id: 'other-half', name: 'Other', outputPrice: 0 },
				],
			})

			expect(step.choices.find((choice) => choice.id === 'half')?.note).toBeUndefined()
			expect(step.choices.find((choice) => choice.id === 'other-half')?.note).toBeUndefined()
		})

		it('does not mark a model that charges anything at all', () => {
			const step = modelStep(DEFAULT, {
				kind: 'ok',
				models: [{ id: 'paid', name: 'Paid', inputPrice: 0, outputPrice: 15 }],
			})

			expect(step.choices.find((choice) => choice.id === 'paid')?.note).toBeUndefined()
		})

		it('keeps the free marker alongside the other notes', () => {
			const step = modelStep(DEFAULT, {
				kind: 'ok',
				models: [
					{
						id: 'free-vision',
						name: 'Free Vision',
						inputModalities: ['text', 'image'],
						inputPrice: 0,
						outputPrice: 0,
					},
				],
			})

			expect(step.choices.find((choice) => choice.id === 'free-vision')?.note).toBe(
				'(image input · free)',
			)
		})
	})

	// Real rows from https://openrouter.ai/api/v1/models, unauthenticated, taken
	// on 2026-09-18. Prices are in the driver's own unit — per million tokens,
	// `pricing.prompt` × 1e6 as `@namzu/openrouter` converts it — so these are
	// the numbers the picker is handed rather than numbers invented to fit.
	describe('the free note', () => {
		const FREE_ROW = {
			// 25 of OpenRouter's 445 rows are zero-priced, and this one says so
			// nowhere but in its price: neither the ID nor the display name
			// carries the word.
			id: 'google/lyria-3-pro-preview',
			name: 'Google: Lyria 3 Pro Preview',
			inputPrice: 0,
			outputPrice: 0,
		}
		const PAID_ROW = {
			id: 'unbiased/pareto',
			name: 'Pareto',
			inputPrice: 2.5, // pricing.prompt 0.0000025
			outputPrice: 7.5, // pricing.completion 0.0000075
		}

		const noteFor = (models: Parameters<typeof modelStep>[1]): string | undefined =>
			modelStep(DEFAULT, models).choices.find((choice) => choice.id !== DEFAULT)?.note

		it('marks a model the provider prices at zero on both sides', () => {
			expect(noteFor({ kind: 'ok', models: [FREE_ROW] })).toBe('(free)')
			expect(
				noteFor({ kind: 'ok', models: [{ id: 'a', name: 'A', inputPrice: 0, outputPrice: 0 }] }),
			).toBe('(free)')
		})

		it('does not mark a paid model', () => {
			expect(noteFor({ kind: 'ok', models: [PAID_ROW] })).toBeUndefined()
		})

		it('does not mark a model that is free to prompt and paid to complete', () => {
			// OpenRouter served no model with one zero side on 2026-09-18 — every
			// paid row it lists is paid on both. The id and the price are real;
			// zeroing one side is the case, and the completion is the side that
			// carries the tokens, so a free prompt is not a free model.
			expect(
				noteFor({
					kind: 'ok',
					models: [
						{
							id: '~deepseek/deepseek-flash-latest',
							name: 'DeepSeek Flash',
							inputPrice: 0,
							outputPrice: 0.6,
						},
					],
				}),
			).toBeUndefined()
			expect(
				noteFor({
					kind: 'ok',
					models: [{ id: PAID_ROW.id, name: PAID_ROW.name, inputPrice: 2.5, outputPrice: 0 }],
				}),
			).toBeUndefined()
		})

		it('says nothing when the driver published no price', () => {
			// The shape a listing takes when the driver established nothing. It
			// must not read as free: that is the whole reason the picker type
			// allows the fields to be absent instead of requiring a number.
			expect(
				noteFor({ kind: 'ok', models: [{ id: PAID_ROW.id, name: PAID_ROW.name }] }),
			).toBeUndefined()
		})

		it('says nothing for a price that is not a usable number', () => {
			for (const prices of [
				{ inputPrice: Number.NaN, outputPrice: 0 },
				{ inputPrice: 0, outputPrice: Number.NaN },
				{ inputPrice: Number.POSITIVE_INFINITY, outputPrice: Number.POSITIVE_INFINITY },
			]) {
				expect(
					noteFor({ kind: 'ok', models: [{ id: 'a', name: 'A', ...prices }] }),
					JSON.stringify(prices),
				).toBeUndefined()
			}
		})

		it('carries the free note beside the other notes', () => {
			const step = modelStep('nex-agi/nex-n2.5-mini:free', {
				kind: 'ok',
				models: [
					{
						// Also real, and also zero-priced.
						id: 'nex-agi/nex-n2.5-mini:free',
						name: 'Nex AGI: Nex-N2.5-Mini (free)',
						inputModalities: ['text', 'image'],
						inputPrice: 0,
						outputPrice: 0,
					},
				],
			})
			expect(step.choices).toHaveLength(1)
			expect(step.choices[0]?.note).toBe('(namzu default · image input · free)')
		})
	})

	it('starts on the model already in force', () => {
		const step = modelStep(
			DEFAULT,
			{
				kind: 'ok',
				models: [
					{ id: 'a', name: 'A' },
					{ id: 'b', name: 'B' },
				],
			},
			'b',
		)
		expect(step.choices[step.initialIndex]?.id).toBe('b')
	})

	it('starts on the default when nothing is in force', () => {
		const step = modelStep(DEFAULT, {
			kind: 'ok',
			models: [{ id: 'a', name: 'A' }],
		})
		expect(step.choices[step.initialIndex]?.id).toBe(DEFAULT)
	})

	it('keeps the active custom pin selected when discovery cannot list it', () => {
		for (const listing of [
			{ kind: 'unsupported' },
			{ kind: 'timeout' },
			{ kind: 'failed', reason: 'offline' },
			{ kind: 'ok', models: [] },
			{ kind: 'ok', models: [{ id: 'other-model', name: 'Other' }] },
		] as const) {
			const step = modelStep(DEFAULT, listing, 'custom-deployment')
			expect(step.choices[step.initialIndex]).toMatchObject({
				id: 'custom-deployment',
				note: '(current)',
			})
			expect(step.choices.some((choice) => choice.id === DEFAULT)).toBe(true)
		}
	})

	// The four cases that used to be one empty array. Each must say which it is,
	// and each must still leave something selectable — a screen that can end
	// with nothing to pick is a dead end.
	describe('when the list is not a real list', () => {
		it('distinguishes a timeout from an empty catalogue', () => {
			const timedOut = modelStep(DEFAULT, { kind: 'timeout' })
			const empty = modelStep(DEFAULT, { kind: 'ok', models: [] })

			expect(timedOut.notice).toContain('did not answer in time')
			expect(empty.notice).toContain('returned no models')
			// The distinction is the point: these must not read the same.
			expect(timedOut.notice).not.toBe(empty.notice)
		})

		it('says when the driver cannot list at all', () => {
			const step = modelStep(DEFAULT, { kind: 'unsupported' })
			expect(step.notice).toContain('does not publish a model list')
		})

		it('carries the provider’s own reason when it errored', () => {
			const step = modelStep(DEFAULT, { kind: 'failed', reason: 'HTTP 503' })
			expect(step.notice).toContain('HTTP 503')
		})

		it('never tells the operator the fallback is the provider’s own default', () => {
			// The row is labelled `(namzu default)` because it is namzu's pick out
			// of its own registry. These four sentences sit beside that label and
			// said "showing ITS default" — contradicting it on the same screen,
			// and pointing an operator who did not expect this model at the
			// provider instead of at `preferences.json`, which is where they can
			// actually change it.
			for (const listing of [
				{ kind: 'timeout' },
				{ kind: 'unsupported' },
				{ kind: 'ok', models: [] },
				{ kind: 'failed', reason: 'x' },
			] as const) {
				const notice = modelStep(DEFAULT, listing).notice ?? ''
				expect(notice, JSON.stringify(listing)).not.toMatch(/its default|the provider's default/i)
				expect(notice, JSON.stringify(listing)).toContain("namzu's pick")
			}
		})

		it('always leaves the default selectable', () => {
			for (const listing of [
				{ kind: 'timeout' },
				{ kind: 'unsupported' },
				{ kind: 'ok', models: [] },
				{ kind: 'failed', reason: 'x' },
			] as const) {
				const step = modelStep(DEFAULT, listing)
				expect(
					step.choices.map((c) => c.id),
					JSON.stringify(listing),
				).toEqual([DEFAULT])
				expect(step.choices[step.initialIndex]?.id).toBe(DEFAULT)
			}
		})

		it('never claims a real list when there is none', () => {
			// `notice === null` is how the view decides to show nothing. A silent
			// fallback is the failure this union exists to prevent.
			for (const listing of [
				{ kind: 'timeout' },
				{ kind: 'unsupported' },
				{ kind: 'ok', models: [] },
				{ kind: 'failed', reason: 'x' },
			] as const) {
				expect(modelStep(DEFAULT, listing).notice, JSON.stringify(listing)).not.toBeNull()
			}
		})
	})
})
