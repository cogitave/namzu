import { describe, expect, it } from 'vitest'

import { modelStep } from './model-choices.js'

const DEFAULT = 'claude-sonnet-4-5'

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
		expect(step.choices.find((c) => c.id === DEFAULT)?.note).toBe('(default)')
		expect(step.choices.filter((c) => c.id === DEFAULT)).toHaveLength(1)
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
