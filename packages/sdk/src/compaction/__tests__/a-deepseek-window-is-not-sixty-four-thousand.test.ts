import { describe, expect, it } from 'vitest'

import {
	lookupContextWindow,
	resolveContextWindow,
	resolveTriggerThreshold,
} from '../context-window.js'

/**
 * A session on the DeepSeek API compacted every few turns. Every id with
 * "deepseek" in it resolved to 64,000 tokens, so the trigger sat at 32,000
 * (the 0.5 floor on a small window) and a system prompt plus tools plus a few
 * turns passed it. The vendor documents a 1M window for the current models.
 */
const triggerTokens = (model: string, maxOutput?: number) => {
	const { tokens } = resolveContextWindow(undefined, model)
	return Math.floor(tokens * resolveTriggerThreshold(undefined, tokens, maxOutput))
}

describe('the hand table for DeepSeek ids', () => {
	it.each(['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-flash'])(
		'puts %s on the documented 1M window, not 64k',
		(id) => {
			expect(lookupContextWindow(id)).toBe(1_000_000)
			// Was 32,000 before the fix.
			expect(triggerTokens(id, 384_000)).toBe(967_000)
		},
	)

	it('reaches gateway-qualified spellings of a named id', () => {
		expect(lookupContextWindow('deepseek/deepseek-v4-pro')).toBe(1_000_000)
		expect(lookupContextWindow('deepseek/deepseek-v4-flash:free')).toBe(1_000_000)
	})

	it.each([
		'deepseek-flash-lite',
		'deepseek-v4-flash-vision-exp',
		'deepseek-v4-pro-distill-qwen-32b',
		'deepseek/deepseek-v4-pro-distill',
		'deepseek-flash-lite:free',
	])('keeps %s, a derivative, at 64k', (id) => {
		expect(lookupContextWindow(id)).toBe(64_000)
	})

	it('never over-estimates a DeepSeek id it does not name', () => {
		// A gateway derivative of the family: the parent's window is not a given.
		expect(lookupContextWindow('deepseek-v4.1-flash-uncensored')).toBe(64_000)
		expect(lookupContextWindow('deepseek-v5-preview')).toBe(64_000)
	})

	it('keeps the old window for ids that predate the 1M generation', () => {
		expect(lookupContextWindow('deepseek-chat')).toBe(64_000)
		expect(lookupContextWindow('deepseek-r1-distill-llama-70b')).toBe(64_000)
	})
})

describe('the ids a gateway lists for the current generation', () => {
	it.each([
		'deepseek-v4.1-flash',
		'deepseek-v4.1-flash-1017',
		'deepseek/deepseek-v4.1-flash-1017',
		'deepseek/deepseek-v4.1-flash-1017:batch',
		'deepseek-v4-flash-0731',
		'deepseek/deepseek-v4-pro-0813',
	])('puts %s on the documented 1M window', (id) => {
		expect(lookupContextWindow(id)).toBe(1_000_000)
		expect(resolveContextWindow(undefined, id).tokens).toBe(1_000_000)
	})

	it('lets the provider-reported window win over the table', () => {
		expect(resolveContextWindow(undefined, 'deepseek/deepseek-v4.1-flash-1017', 1_048_576)).toEqual(
			{
				tokens: 1_048_576,
				source: 'provider',
			},
		)
	})
})
