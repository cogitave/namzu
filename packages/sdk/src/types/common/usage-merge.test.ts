import { describe, expect, it } from 'vitest'

import { type TokenUsage, accumulateTokenUsage, mergeTokenUsage } from './index.js'

const zero: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/**
 * M7: within one streamed turn, usage frames are cumulative/monotonic but a
 * late frame may omit fields. `mergeTokenUsage` keeps the per-field high-water
 * mark so a trailing output-only frame does not zero the earlier prompt/cache
 * counts (the under-report the audit flagged).
 */
describe('mergeTokenUsage (within-turn, per-field max)', () => {
	it('preserves prompt/cache tokens when a later frame reports only output', () => {
		// message_start-like frame: input + cache set, output still 0.
		const early: TokenUsage = {
			...zero,
			promptTokens: 1200,
			cachedTokens: 800,
			cacheWriteTokens: 200,
		}
		// message_delta-like frame: only output tokens, input/cache dropped to 0.
		const lateOutputOnly: TokenUsage = { ...zero, completionTokens: 350 }

		const merged = mergeTokenUsage(early, lateOutputOnly)
		expect(merged.promptTokens).toBe(1200) // NOT zeroed by the late frame
		expect(merged.cachedTokens).toBe(800)
		expect(merged.cacheWriteTokens).toBe(200)
		expect(merged.completionTokens).toBe(350)
	})

	it('takes the growing (max) completion count across frames', () => {
		const a: TokenUsage = { ...zero, promptTokens: 100, completionTokens: 10 }
		const b: TokenUsage = { ...zero, promptTokens: 100, completionTokens: 42 }
		expect(mergeTokenUsage(a, b).completionTokens).toBe(42)
		// Order-independent (a late smaller frame never regresses the max).
		expect(mergeTokenUsage(b, a).completionTokens).toBe(42)
	})

	it('is distinct from accumulateTokenUsage (which sums across turns)', () => {
		const t1: TokenUsage = { ...zero, promptTokens: 100, completionTokens: 20 }
		const t2: TokenUsage = { ...zero, promptTokens: 100, completionTokens: 30 }
		// merge = max within a turn; accumulate = sum across turns.
		expect(mergeTokenUsage(t1, t2).promptTokens).toBe(100)
		expect(accumulateTokenUsage(t1, t2).promptTokens).toBe(200)
	})
})
