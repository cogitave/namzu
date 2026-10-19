import { describe, expect, it } from 'vitest'

import { resolveTriggerThreshold } from '../context-window.js'

/**
 * The summary trigger: the window, less room kept for the reply (the model's
 * output cap, at most 20,000 tokens), less a 13,000-token buffer. A host that
 * names a threshold gets exactly that.
 */
describe('resolveTriggerThreshold', () => {
	it('fires at 167,000 tokens on a 200,000 window', () => {
		const fraction = resolveTriggerThreshold(undefined, 200_000)
		expect(Math.floor(200_000 * fraction)).toBe(167_000)
		expect(fraction).toBeCloseTo(0.835, 5)
	})

	it('fires at 967,000 tokens on a 1,000,000 window', () => {
		expect(Math.floor(1_000_000 * resolveTriggerThreshold(undefined, 1_000_000))).toBe(967_000)
	})

	it('reserves only what the model can actually write, up to 20,000', () => {
		expect(Math.round(200_000 * resolveTriggerThreshold(undefined, 200_000, 8_192))).toBe(178_808)
		expect(Math.round(200_000 * resolveTriggerThreshold(undefined, 200_000, 64_000))).toBe(167_000)
	})

	it('never drops below half the window on a small one', () => {
		// 32,000 - 20,000 - 13,000 would be negative.
		expect(resolveTriggerThreshold(undefined, 32_000)).toBe(0.5)
		// 66,000 - 33,000 is exactly half.
		expect(resolveTriggerThreshold(undefined, 66_000)).toBe(0.5)
		// 100,000 - 33,000 = 67%.
		expect(resolveTriggerThreshold(undefined, 100_000)).toBeCloseTo(0.67, 5)
	})

	it('keeps an explicit threshold, which is how a host keeps the old 0.7', () => {
		expect(resolveTriggerThreshold(0.7, 200_000)).toBe(0.7)
		expect(resolveTriggerThreshold(0, 200_000)).toBe(0)
	})
})
