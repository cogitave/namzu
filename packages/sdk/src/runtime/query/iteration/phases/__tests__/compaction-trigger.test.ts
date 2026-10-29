import { describe, expect, it } from 'vitest'

import { estimateMessagesTokens } from '../../../../../compaction/token-estimate.js'
import type { Message } from '../../../../../types/message/index.js'
import { NOOP_LOGGER } from '../../../../../utils/log/create-logger.js'
import { runCompactionCheck } from '../compaction.js'
import type { IterationContext } from '../context.js'

/**
 * With no `triggerThreshold` the pass fires at the window less the reply
 * reserve (at most 20,000) less 13,000: 167,000 tokens of a 200,000 window.
 */

/** A history whose estimate is within a percent of `tokens`. */
function historyOf(tokens: number): Message[] {
	const build = (chars: number): Message[] =>
		Array.from({ length: 20 }, () => ({
			role: 'user' as const,
			content: 'x'.repeat(chars),
			timestamp: 1,
		}))
	let chars = Math.ceil((tokens * 4) / 20)
	for (let i = 0; i < 8; i++) {
		const got = estimateMessagesTokens(build(chars))
		chars = Math.max(1, Math.round((chars * tokens) / got))
	}
	return build(chars)
}

function run(
	windowTokens: number,
	tokens: number,
	threshold?: number,
	autoCompactWindowTokens?: number,
) {
	let reduced = 0
	const messages = historyOf(tokens)
	const ctx = {
		recorder: { id: 'b55333a6-c5c4-4dc3-b002-b2cfad381d41', messages, currentIteration: 1 },
		turnConfig: { model: 'mock-model' },
		compactionConfig: {
			strategy: 'custom',
			contextWindowTokens: windowTokens,
			keepRecentMessages: 2,
			...(threshold !== undefined ? { triggerThreshold: threshold } : {}),
			...(autoCompactWindowTokens !== undefined ? { autoCompactWindowTokens } : {}),
		},
		contextReducer: () => {
			reduced++
			return undefined
		},
		log: NOOP_LOGGER,
		emitEvent: async () => {},
	} as unknown as IterationContext
	return runCompactionCheck(ctx).then(() => ({
		reduced,
		estimate: estimateMessagesTokens(messages),
	}))
}

describe('the summary trigger', () => {
	it('uses the configured compact window inside the larger real model window', async () => {
		expect((await run(1_048_576, 700_000, undefined, 786_432)).reduced).toBe(0)
		expect((await run(1_048_576, 800_000, undefined, 786_432)).reduced).toBe(1)
		expect((await run(1_048_576, 800_000)).reduced).toBe(0)
	})
	it('does not fire below 167,000 tokens of a 200,000 window', async () => {
		const out = await run(200_000, 160_000)
		expect(out.estimate).toBeLessThan(167_000)
		expect(out.reduced).toBe(0)
	})

	it('fires above it', async () => {
		const out = await run(200_000, 172_000)
		expect(out.estimate).toBeGreaterThan(167_000)
		expect(out.reduced).toBe(1)
	})

	it('on a small window fires at half of it', async () => {
		expect((await run(32_000, 14_000)).reduced).toBe(0)
		expect((await run(32_000, 18_000)).reduced).toBe(1)
	})

	it('an explicit 0.7 keeps the earlier trigger', async () => {
		// 150,000 is 75% of 200,000: over 0.7, under the derived 83.5%.
		expect((await run(200_000, 150_000, 0.7)).reduced).toBe(1)
		expect((await run(200_000, 150_000)).reduced).toBe(0)
	})
})
