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
	it.each([
		'deepseek-v4-flash',
		'deepseek-v4-pro',
		'deepseek-v4-flash-vision-exp',
		'deepseek-flash',
	])('puts %s on the documented 1M window, not 64k', (id) => {
		expect(lookupContextWindow(id)).toBe(1_000_000)
		// Was 32,000 before the fix.
		expect(triggerTokens(id, 384_000)).toBe(967_000)
	})

	it('reaches gateway-qualified ids by longest key', () => {
		expect(lookupContextWindow('deepseek/deepseek-v4-pro')).toBe(1_000_000)
		expect(lookupContextWindow('deepseek-v4.1-flash-uncensored')).toBe(1_000_000)
	})

	it('keeps the old window for ids that predate the 1M generation', () => {
		expect(lookupContextWindow('deepseek-chat')).toBe(64_000)
		expect(lookupContextWindow('deepseek-r1-distill-llama-70b')).toBe(64_000)
	})
})
