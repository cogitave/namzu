import { describe, expect, it } from 'vitest'

import {
	DEFAULT_ASSUMED_CONTEXT_WINDOW,
	lookupContextWindow,
	resolveContextWindow,
} from '../context-window.js'

/**
 * The compaction trigger divides "how full is the context" by a window.
 * It used to divide by `runConfig.tokenBudget` — a cumulative spend cap,
 * a different quantity entirely — which is why the whole subsystem was
 * inert in every shipped consumer.
 */

describe('lookupContextWindow', () => {
	it('resolves dated model ids through their family prefix', () => {
		expect(lookupContextWindow('claude-opus-5-20260514')).toBe(1_000_000)
		expect(lookupContextWindow('claude-sonnet-5')).toBe(1_000_000)
	})

	it('resolves namespaced ids from Bedrock and OpenRouter', () => {
		expect(lookupContextWindow('us.anthropic.claude-sonnet-5-v1:0')).toBe(1_000_000)
		expect(lookupContextWindow('anthropic/claude-opus-5')).toBe(1_000_000)
	})

	// The window is not a property of the family. Within one family and one
	// major version, 4.5 is 200k and 4.6+ is 1M, so a key covering the whole
	// family gets one of the two wrong. The table shipped with exactly that
	// bug: a family-level key answered 200k for every 4.x, which made a
	// 1M run compact at ~14% full. The ids below are the assertion.
	it('separates the 1M models from the 200k ones inside the same family', () => {
		expect(lookupContextWindow('claude-opus-4-8')).toBe(1_000_000)
		expect(lookupContextWindow('claude-opus-4-7')).toBe(1_000_000)
		expect(lookupContextWindow('claude-opus-4-6')).toBe(1_000_000)
		expect(lookupContextWindow('claude-sonnet-4-6')).toBe(1_000_000)

		expect(lookupContextWindow('claude-opus-4-5-20251101')).toBe(200_000)
		expect(lookupContextWindow('claude-sonnet-4-5-20250929')).toBe(200_000)
		expect(lookupContextWindow('claude-haiku-4-5-20251001')).toBe(200_000)
	})

	it('keeps an unlisted Claude id on the conservative 200k floor', () => {
		// Over-stating kills a run with `context_length_exceeded` and nothing
		// recoverable; under-stating costs one summarization pass. An id this
		// table has never seen takes the survivable error.
		expect(lookupContextWindow('claude-something-unreleased')).toBe(200_000)
	})

	it('is case-insensitive', () => {
		expect(lookupContextWindow('GPT-4O')).toBe(128_000)
	})

	it('prefers the more specific key when two prefixes both match', () => {
		// 'gpt-4' also matches 'gpt-4.1' and 'gpt-4o' as a substring; the
		// longest key must win or every GPT-4 family model collapses to 8k.
		expect(lookupContextWindow('gpt-4.1')).toBe(1_047_576)
		expect(lookupContextWindow('gpt-4o-mini')).toBe(128_000)
		expect(lookupContextWindow('gpt-4')).toBe(8_192)
	})

	it('returns undefined for an unknown model rather than guessing', () => {
		expect(lookupContextWindow('some-local-finetune-v3')).toBeUndefined()
		expect(lookupContextWindow(undefined)).toBeUndefined()
	})
})

describe('resolveContextWindow', () => {
	it('an explicit config value wins over the table', () => {
		expect(resolveContextWindow(50_000, 'claude-opus-5')).toEqual({
			tokens: 50_000,
			source: 'config',
		})
	})

	it('falls back to the model table', () => {
		expect(resolveContextWindow(undefined, 'claude-opus-5')).toEqual({
			tokens: 1_000_000,
			source: 'model-table',
		})
	})

	it('falls back to a conservative default for an unknown model', () => {
		expect(resolveContextWindow(undefined, 'mystery-model')).toEqual({
			tokens: DEFAULT_ASSUMED_CONTEXT_WINDOW,
			source: 'default',
		})
	})

	it('ignores a zero or negative configured window instead of dividing by it', () => {
		expect(resolveContextWindow(0, 'claude-opus-5').source).toBe('model-table')
		expect(resolveContextWindow(-1, 'claude-opus-5').source).toBe('model-table')
	})

	it('never returns zero — the trigger divides by this', () => {
		for (const model of [undefined, '', 'unknown', 'claude-opus-5', 'gpt-4']) {
			expect(resolveContextWindow(undefined, model).tokens).toBeGreaterThan(0)
		}
	})
})
