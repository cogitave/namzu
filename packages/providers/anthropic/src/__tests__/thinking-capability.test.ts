import { describe, expect, it } from 'vitest'

import {
	resolveEffort,
	resolveThinkingBody,
	resolveThinkingCapability,
} from '../thinking-capability.js'

/**
 * The driver mapped `enabled` straight through and everything else to
 * `disabled`. On a current model that is not a degraded request, it is a
 * failed one: `thinking.type.enabled` is rejected with a 400 from 4.7 onward,
 * `adaptive` is rejected on 4.5 and earlier, and the always-on models reject
 * `disabled`.
 *
 * The table below is transcribed from the vendor's per-model reference, one
 * case per row, because that table IS the specification — a summary of it in
 * prose would be the thing that drifts.
 */

/** [model, adaptive, manual, canDisable, effort] */
const TABLE: readonly [string, boolean, boolean, boolean, boolean][] = [
	['claude-fable-5', true, false, false, true],
	['claude-mythos-5', true, false, false, true],
	['claude-mythos-preview', true, true, false, true],
	['claude-opus-5', true, false, true, true],
	['claude-opus-4-8', true, false, true, true],
	['claude-opus-4-7', true, false, true, true],
	['claude-sonnet-5', true, false, true, true],
	['claude-opus-4-6', true, true, true, true],
	['claude-sonnet-4-6', true, true, true, true],
	['claude-opus-4-5', false, true, true, true],
	['claude-haiku-4-5', false, true, true, false],
	['claude-sonnet-4-5', false, true, true, false],
	['claude-opus-4-1', false, true, true, false],
]

describe('what each model accepts', () => {
	for (const [model, adaptive, manual, canDisable, effort] of TABLE) {
		it(`resolves ${model}`, () => {
			expect(resolveThinkingCapability(model)).toEqual({ adaptive, manual, canDisable, effort })
		})
	}

	it('tolerates a vendor prefix and a date suffix', () => {
		expect(resolveThinkingCapability('anthropic/claude-sonnet-5')).toMatchObject({
			adaptive: true,
			manual: false,
		})
		expect(resolveThinkingCapability('claude-sonnet-4-5-20250929')).toMatchObject({
			adaptive: false,
			manual: true,
		})
	})

	it('treats an unrecognised model as manual-only', () => {
		// The pre-existing behaviour, and the safe answer for a name this
		// table has not seen: an older model behind a gateway keeps working,
		// and a newer one fails with the vendor's own clear 400 rather than
		// with a request this driver quietly rewrote.
		expect(resolveThinkingCapability('some-gateway/mystery-model')).toEqual({
			adaptive: false,
			manual: true,
			canDisable: true,
			effort: false,
		})
	})
})

describe('turning an intent into a body this model accepts', () => {
	const adaptiveOnly = resolveThinkingCapability('claude-sonnet-5')
	const manualOnly = resolveThinkingCapability('claude-sonnet-4-5')
	const alwaysOn = resolveThinkingCapability('claude-fable-5')

	it('sends adaptive to an adaptive model', () => {
		expect(resolveThinkingBody({ type: 'adaptive' }, adaptiveOnly)).toEqual({ type: 'adaptive' })
	})

	it('rewrites a manual intent to adaptive where manual is rejected', () => {
		// The caller asked to think. This model's way of thinking is adaptive,
		// and the budget has no meaning there, so it goes.
		expect(resolveThinkingBody({ type: 'enabled', budgetTokens: 10_000 }, adaptiveOnly)).toEqual({
			type: 'adaptive',
		})
	})

	it('rewrites an adaptive intent to manual where adaptive is rejected', () => {
		expect(resolveThinkingBody({ type: 'adaptive' }, manualOnly)).toEqual({ type: 'enabled' })
	})

	it('keeps the budget on a model that has budgets', () => {
		expect(resolveThinkingBody({ type: 'enabled', budgetTokens: 10_000 }, manualOnly)).toEqual({
			type: 'enabled',
			budget_tokens: 10_000,
		})
	})

	it('carries display through, which is the whole reason thinking text arrives', () => {
		// It defaults to `omitted` on newer models, so a caller who wants to
		// show reasoning and never serializes this gets empty blocks.
		expect(resolveThinkingBody({ type: 'adaptive', display: 'summarized' }, adaptiveOnly)).toEqual({
			type: 'adaptive',
			display: 'summarized',
		})
	})

	it('omits the field entirely when a model cannot be told to stop thinking', () => {
		// Not an error: failing here teaches nothing the vendor 400 would not,
		// and it breaks a caller whose config spans models. No field means the
		// model's documented default, which is the closest honest reading.
		expect(resolveThinkingBody({ type: 'disabled' }, alwaysOn)).toBeUndefined()
	})

	it('honours disable where it is accepted', () => {
		expect(resolveThinkingBody({ type: 'disabled' }, adaptiveOnly)).toEqual({ type: 'disabled' })
	})

	it('sends nothing when the caller asked for nothing', () => {
		expect(resolveThinkingBody(undefined, adaptiveOnly)).toBeUndefined()
	})
})

describe('when effort rides along', () => {
	const adaptiveOnly = resolveThinkingCapability('claude-sonnet-5')
	const noEffort = resolveThinkingCapability('claude-sonnet-4-5')

	it('passes effort to a model that takes it', () => {
		expect(resolveEffort('high', { type: 'adaptive' }, adaptiveOnly)).toBe('high')
	})

	it('drops effort on a model that does not', () => {
		expect(resolveEffort('high', { type: 'enabled' }, noEffort)).toBeUndefined()
	})

	it('keeps effort on the one manual model that accepts it', () => {
		// Opus 4.5: effort shapes the answer, the budget sets thinking depth,
		// and both are meant to be set. So effort is not adaptive-only and
		// must not be gated on the mode.
		const opus45 = resolveThinkingCapability('claude-opus-4-5')
		expect(resolveEffort('high', { type: 'enabled', budget_tokens: 8000 }, opus45)).toBe('high')
	})

	it('refuses the combination the vendor rejects', () => {
		// Thinking off at effort xhigh/max is a 400 on Opus 5 and later, and
		// is incoherent anyway: do not think, and think as hard as possible.
		expect(resolveEffort('xhigh', { type: 'disabled' }, adaptiveOnly)).toBeUndefined()
		expect(resolveEffort('max', { type: 'disabled' }, adaptiveOnly)).toBeUndefined()
		expect(resolveEffort('high', { type: 'disabled' }, adaptiveOnly)).toBe('high')
	})
})
