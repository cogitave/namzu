// Current-code invariants asserted (2026-07-12, ses_015 pre-freeze R6 M1):
// - Every compaction budget is a FINITE POSITIVE INTEGER at the schema boundary.
//   `z.number().positive()` was not: it admitted the two values that make the
//   "bounded carry" the compaction pass promises literally false — a fractional
//   budget, which the cap spends as a whole character, and Infinity, which every
//   cost comparison passes.
// - The defaults are unchanged by the tightening.
import { describe, expect, it } from 'vitest'
import { CompactionConfigSchema, RUNTIME_DEFAULTS } from './runtime.js'

/** Every field in the schema that is a COUNT — of messages, slots, tokens, or chars. */
const BUDGET_FIELDS = [
	'keepRecentMessages',
	'maxToolResults',
	'maxListSize',
	'llmVerificationMaxTokens',
	'richStateThreshold',
	'convoTextBudget',
	'maxSentencesPerTurn',
	'maxCharsPerNote',
	'maxCharsPerRequirement',
	'maxCharsPerTask',
] as const

const DEGENERATE = [
	['a fraction', 0.5],
	['infinity', Number.POSITIVE_INFINITY],
	['negative infinity', Number.NEGATIVE_INFINITY],
	['zero', 0],
	['a negative', -1],
	['NaN', Number.NaN],
] as const

describe('CompactionConfigSchema — every budget is a finite positive integer', () => {
	it.each(BUDGET_FIELDS)('%s rejects every degenerate value and accepts a count', (field) => {
		for (const [label, value] of DEGENERATE) {
			const result = CompactionConfigSchema.safeParse({ [field]: value })
			expect(result.success, `${field} must reject ${label}`).toBe(false)
		}
		expect(CompactionConfigSchema.safeParse({ [field]: 7 }).success).toBe(true)
	})

	it('leaves the defaults exactly where they were', () => {
		const parsed = CompactionConfigSchema.parse({})
		expect(parsed.convoTextBudget).toBe(12_000)
		expect(parsed.keepRecentMessages).toBe(4)
		expect(parsed.maxCharsPerNote).toBe(500)
		expect(RUNTIME_DEFAULTS.compaction.convoTextBudget).toBe(12_000)
	})
})

/**
 * The two values named in the finding, and why each one broke the guarantee rather
 * than merely being odd. Both are now unrepresentable, which is what lets
 * `capCarryEntries` state its policy — "bounded, newest-first" — without a caveat.
 */
describe('convoTextBudget — the two values that made the bounded carry unbounded', () => {
	it('rejects a fractional budget, which the cap would spend as a whole character', () => {
		// In `capCarryEntries`, a budget of 0.5 leaves `room = 0.5 - CARRY_ELISION_MARKER.length`,
		// which is negative, so the newest entry is hard-truncated to
		// `Math.max(1, Math.floor(0.5))` = ONE character — one more than the budget
		// permits. The code enforcing the cap is the code exceeding it.
		expect(CompactionConfigSchema.safeParse({ convoTextBudget: 0.5 }).success).toBe(false)
	})

	it('rejects an infinite budget, which every entry passes and nothing bounds', () => {
		// `used + cost <= Infinity` holds for every entry that will ever be carried, so
		// the carry list — the thing this budget exists to bound — grows without limit
		// across passes, and the summary with it.
		expect(
			CompactionConfigSchema.safeParse({ convoTextBudget: Number.POSITIVE_INFINITY }).success,
		).toBe(false)
	})
})
