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

const ALL = ['low', 'medium', 'high', 'xhigh', 'max']
/** 4.6 has `max` but not `xhigh` — `xhigh` arrived with 4.7. */
const NO_XHIGH = ['low', 'medium', 'high', 'max']
/** 4.5 has neither. */
const BASE = ['low', 'medium', 'high']
const NONE: string[] = []

/**
 * [model, adaptive, manual, canDisable, effort levels]
 *
 * Every currently-served model, plus the legacy ones a gateway may still be
 * pointed at. `effort` is the accepted LEVELS, not a flag: the ceiling moved
 * twice, so a boolean could not say that `xhigh` is rejected on 4.6 and `max`
 * is rejected on 4.5 — which is exactly what it failed to say.
 */
const CAPPED = BASE // opus 5 with thinking off
const TABLE: readonly [string, boolean, boolean, boolean, string[], string[]][] = [
	// Always-on: thinking cannot be switched off, at any effort level. Two
	// whole families, and Opus from 5.5 — the vendor's list of models that
	// answer `thinking: {type: "disabled"}` with a 400.
	['claude-fable-5-1', true, false, false, ALL, ALL],
	['claude-mythos-5-1', true, false, false, ALL, ALL],
	['claude-fable-5', true, false, false, ALL, ALL],
	['claude-mythos-5', true, false, false, ALL, ALL],
	// Crossed at a minor version, which the version fallback read as "a newer
	// adaptive Opus, so it can disable thinking and caps effort while off":
	// `disabled` went to the wire and came back 400 at every effort level, and
	// `disabled` + `max` was refused locally as an effort problem.
	['claude-opus-5-5', true, false, false, ALL, ALL],
	// The preview takes `max` and NOT `xhigh`, which is the pairing it is easy
	// to assume away — the reference says outright that some models supporting
	// `max` do not support `xhigh`, and this is one. Reading the levels as a
	// ladder is what put ALL on this row originally, and a ladder reading sends
	// a level the wire rejects.
	['claude-mythos-preview', true, true, false, NO_XHIGH, NO_XHIGH],
	// 4.7 and later: adaptive only, and it can still be disabled.
	['claude-opus-5', true, false, true, ALL, CAPPED],
	['claude-sonnet-5', true, false, true, ALL, ALL],
	['claude-opus-4-8', true, false, true, ALL, ALL],
	['claude-opus-4-7', true, false, true, ALL, ALL],
	// 4.6: both modes, manual deprecated but working — and no `xhigh`.
	['claude-opus-4-6', true, true, true, NO_XHIGH, NO_XHIGH],
	['claude-sonnet-4-6', true, true, true, NO_XHIGH, NO_XHIGH],
	// 4.5 and earlier: manual only. Opus 4.5 is the one that takes effort,
	// and only the first three levels.
	['claude-opus-4-5', false, true, true, BASE, BASE],
	['claude-haiku-4-5', false, true, true, NONE, NONE],
	['claude-sonnet-4-5', false, true, true, NONE, NONE],
	['claude-opus-4-1', false, true, true, NONE, NONE],
]

describe('what each model accepts', () => {
	for (const [model, adaptive, manual, canDisable, effort, effortWhenDisabled] of TABLE) {
		it(`resolves ${model}`, () => {
			expect(resolveThinkingCapability(model)).toEqual({
				adaptive,
				manual,
				canDisable,
				effort,
				effortWhenDisabled,
			})
		})
	}

	it('keeps a family always-on at every version after it crossed', () => {
		// A floor, not a list of ids: the next Opus inherits "cannot stop
		// thinking" instead of falling back to "can", which is the default that
		// sent `disabled` to Opus 5.5. The line is still where the vendor drew
		// it — the Opus below it keeps its switch.
		for (const model of ['claude-opus-5-6', 'claude-opus-6', 'anthropic/claude-opus-5-5']) {
			expect(resolveThinkingCapability(model), model).toMatchObject({ canDisable: false })
		}
		expect(resolveThinkingCapability('claude-opus-5')).toMatchObject({ canDisable: true })
		// Only the family that crossed moves: Sonnet has no floor, so a later
		// Sonnet still resolves through the version fallback.
		expect(resolveThinkingCapability('claude-sonnet-5-5')).toMatchObject({ canDisable: true })
	})

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

	it('does not read a date suffix as the minor version', () => {
		// The row this table did not have. Every dated id it listed carried a
		// REAL minor (`4-5-20250929`), so the `<family>-<major>-<DATE>` shape —
		// a dated id naming no minor — was never exercised, and the matcher
		// parsed its date as minor 20250514. That compared as enormously newer
		// than 4.1, so these two were classified adaptive-only and had their
		// caller's thinking budget silently discarded.
		for (const model of ['claude-sonnet-4-20250514', 'claude-opus-4-20250514']) {
			expect(resolveThinkingCapability(model), model).toMatchObject({
				adaptive: false,
				manual: true,
			})
		}
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
			effort: [],
			effortWhenDisabled: [],
		})
	})
})

describe('turning an intent into a body this model accepts', () => {
	const adaptiveOnly = resolveThinkingCapability('claude-sonnet-5')
	const manualOnly = resolveThinkingCapability('claude-sonnet-4-5')
	const alwaysOn = resolveThinkingCapability('claude-fable-5')

	it('sends adaptive to an adaptive model', () => {
		expect(resolveThinkingBody({ type: 'adaptive' }, adaptiveOnly)).toEqual({
			type: 'adaptive',
		})
	})

	it('rewrites a manual intent to adaptive where manual is rejected', () => {
		// The caller asked to think. This model's way of thinking is adaptive,
		// and the budget has no meaning there, so it goes.
		expect(resolveThinkingBody({ type: 'enabled', budgetTokens: 10_000 }, adaptiveOnly)).toEqual({
			type: 'adaptive',
		})
	})

	it('rewrites an adaptive intent to manual where adaptive is rejected', () => {
		expect(resolveThinkingBody({ type: 'adaptive' }, manualOnly)).toEqual({
			type: 'enabled',
		})
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

	it('omits it on Opus 5.5 too, where the same intent works one minor below', () => {
		// A config shared across the Opus line: accepted on Opus 5 at `high` or
		// below, a 400 on Opus 5.5 at every level. The vendor's migration says
		// to delete the setting; this is the driver doing that per model.
		const opus55 = resolveThinkingCapability('claude-opus-5-5')
		expect(resolveThinkingBody({ type: 'disabled' }, opus55)).toBeUndefined()
		expect(
			resolveThinkingBody({ type: 'disabled' }, resolveThinkingCapability('claude-opus-5')),
		).toEqual({
			type: 'disabled',
		})
	})

	it('honours disable where it is accepted', () => {
		expect(resolveThinkingBody({ type: 'disabled' }, adaptiveOnly)).toEqual({
			type: 'disabled',
		})
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

	it('refuses effort on a model that does not accept any level', () => {
		expect(() => resolveEffort('high', { type: 'enabled' }, noEffort)).toThrow(
			/Supported levels: none/,
		)
	})

	it('keeps effort on the one manual model that accepts it', () => {
		// Opus 4.5: effort shapes the answer, the budget sets thinking depth,
		// and both are meant to be set. So effort is not adaptive-only and
		// must not be gated on the mode.
		const opus45 = resolveThinkingCapability('claude-opus-4-5')
		expect(resolveEffort('high', { type: 'enabled', budget_tokens: 8000 }, opus45)).toBe('high')
	})

	it('caps effort with thinking off only where the wire caps it', () => {
		// This rule used to be blanket: thinking off at `xhigh`/`max` was
		// refused on every model that can disable thinking, reasoning that the
		// pairing is incoherent anyway. Measured against the live API, that was
		// too wide — only the Opus 5 family rejects it:
		//
		//   claude-opus-5   + disabled + max   -> 400 "not supported when thinking is disabled"
		//   claude-sonnet-5 + disabled + max   -> accepted
		//   claude-opus-4-8 + disabled + max   -> accepted
		//
		// So the blanket rule was dropping an effort the caller asked for and
		// the wire would have honoured. Looking incoherent is not the same as
		// being rejected, and only the wire decides which.
		const opus5 = resolveThinkingCapability('claude-opus-5')
		expect(() => resolveEffort('max', { type: 'disabled' }, opus5)).toThrow(/Supported levels/)
		expect(() => resolveEffort('xhigh', { type: 'disabled' }, opus5)).toThrow(/Supported levels/)
		expect(resolveEffort('high', { type: 'disabled' }, opus5)).toBe('high')
		// …and uncapped with thinking on, on the same model.
		expect(resolveEffort('max', { type: 'adaptive' }, opus5)).toBe('max')

		// `adaptiveOnly` here is Sonnet 5, which the wire does not cap.
		expect(resolveEffort('max', { type: 'disabled' }, adaptiveOnly)).toBe('max')
	})

	it('keeps every level on Opus 5.5 when the caller asked for thinking off', () => {
		// The Opus 5 cap used to reach this model too, and it misdirected: a
		// `disabled` + `max` request was refused as "effort max is not
		// supported, Supported levels: low, medium, high", when the model takes
		// all five and the thing it rejects is the thinking mode. Following
		// that advice produced the vendor's 400 instead.
		const opus55 = resolveThinkingCapability('claude-opus-5-5')
		const body = resolveThinkingBody({ type: 'disabled' }, opus55)
		for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
			expect(resolveEffort(level, body, opus55, 'claude-opus-5-5'), level).toBe(level)
		}
	})

	it('refuses a level this model does not have', () => {
		// The ceiling moved twice, so "does this model take effort?" was never
		// a yes/no question. While it was modelled as one, `xhigh` on a 4.6 and
		// `max` on a 4.5 went to the wire, and the vendor rejects an unknown
		// level rather than clamping it.
		const v46 = resolveThinkingCapability('claude-opus-4-6')
		expect(() => resolveEffort('xhigh', { type: 'adaptive' }, v46)).toThrow(
			/low, medium, high, max/,
		)
		expect(resolveEffort('max', { type: 'adaptive' }, v46)).toBe('max')

		const opus45 = resolveThinkingCapability('claude-opus-4-5')
		expect(() => resolveEffort('max', { type: 'enabled' }, opus45)).toThrow(/low, medium, high/)
		expect(() => resolveEffort('xhigh', { type: 'enabled' }, opus45)).toThrow(/low, medium, high/)
		expect(resolveEffort('high', { type: 'enabled' }, opus45)).toBe('high')
	})

	it.each(['none', 'minimal', 'ultra'] as const)(
		'does not leak the foreign %s level onto this provider wire',
		(effort) => {
			expect(() => resolveEffort(effort, { type: 'adaptive' }, adaptiveOnly)).toThrow(
				/Choose one of those levels or omit `effort`/,
			)
		},
	)

	it('takes every level on a current model', () => {
		const opus5 = resolveThinkingCapability('claude-opus-5')
		for (const level of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
			expect(resolveEffort(level, { type: 'adaptive' }, opus5), level).toBe(level)
		}
	})
})
