import { describe, expect, it } from 'vitest'

import { parseBedrockUsage } from '../client.js'

/**
 * Cache reads and cache writes are priced differently from ordinary input,
 * so folding either into the prompt count misreports what a run cost — and
 * misreports it silently, because the total still looks plausible.
 *
 * The counters are also the only evidence that the breakpoints are working
 * at all: a run whose cached count stays at zero is paying full price for
 * a prefix it believes is cached, and nothing else says so.
 */

describe('cache counters are reported on their own axis', () => {
	it('keeps reads out of the prompt count', () => {
		const usage = parseBedrockUsage({
			inputTokens: 10,
			outputTokens: 2,
			cacheReadInputTokenCount: 900,
		})

		expect(usage.promptTokens).toBe(10)
		expect(usage.cachedTokens).toBe(900)
	})

	it('keeps writes on their own axis too', () => {
		const usage = parseBedrockUsage({
			inputTokens: 10,
			outputTokens: 2,
			cacheWriteInputTokenCount: 40,
		})

		expect(usage.cacheWriteTokens).toBe(40)
		expect(usage.promptTokens).toBe(10)
	})

	it('reports both when both happen in one turn', () => {
		const usage = parseBedrockUsage({
			inputTokens: 10,
			outputTokens: 2,
			cacheReadInputTokenCount: 900,
			cacheWriteInputTokenCount: 40,
		})

		expect(usage).toMatchObject({ cachedTokens: 900, cacheWriteTokens: 40 })
	})

	it('reads an absent counter as zero, not undefined', () => {
		const usage = parseBedrockUsage({ inputTokens: 5, outputTokens: 1 })

		// A consumer summing these must not have to guard every field; an
		// undefined here becomes NaN one addition later.
		expect(usage.cachedTokens).toBe(0)
		expect(usage.cacheWriteTokens).toBe(0)
	})

	it('totals input and output, and nothing else', () => {
		const usage = parseBedrockUsage({
			inputTokens: 10,
			outputTokens: 2,
			cacheReadInputTokenCount: 900,
		})

		// Cached reads are already counted upstream; adding them here would
		// double-count the same tokens in the run's own ledger.
		expect(usage.totalTokens).toBe(12)
	})

	it('reads a missing usage payload as all zeros', () => {
		const usage = parseBedrockUsage(undefined)

		expect(usage).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		})
	})
})
