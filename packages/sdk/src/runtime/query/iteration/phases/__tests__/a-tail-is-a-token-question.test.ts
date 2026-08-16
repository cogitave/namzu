import { describe, expect, it } from 'vitest'

import { naiveKeepStartByTokens as __naiveKeepStartByTokensForTests } from '../../../../../compaction/plan.js'
import { CompactionConfigSchema } from '../../../../../config/runtime.js'
import type { Message } from '../../../../../types/message/index.js'

/**
 * `keepRecentMessages` cannot say what a tail costs.
 *
 * Four messages is four short turns, or three short turns and a 200 KB
 * tool result. In the second case the retained tail alone approaches
 * `resetThreshold`: the pass completes, reports it did not reach the
 * threshold, leaves the trigger armed — and the next iteration pays
 * another summarization call and busts the prompt-cache prefix again. The
 * size of a tail is a token question and the config could only ask a
 * count.
 *
 * This tests the boundary function directly. It replaces ONLY the naive
 * boundary; the existing safe-cut search runs downward from whatever it
 * returns, so the `tool_use` ↔ `tool_result` guarantee is untouched by
 * construction — which is why there is nothing about pairing here.
 */

const text = (chars: number): Message => ({ role: 'user', content: 'x'.repeat(chars) }) as Message

describe('sizing the retained tail by tokens', () => {
	it('stops before the message that would push the tail over budget', () => {
		// Three short turns and one giant result. At 4 chars/token an 8_000
		// token budget is 32_000 chars, so the 200k message cannot be in the
		// tail and the three after it can.
		const messages = [text(40), text(200_000), text(40), text(40), text(40)]

		const start = __naiveKeepStartByTokensForTests(messages, 8_000)

		expect(start, 'the giant message was kept in the tail').toBe(2)
	})

	it('keeps the final message even when it alone exceeds the budget', () => {
		// It is the live turn. Dropping it to satisfy a size preference
		// deletes the thing the run is answering, and the pass reports that
		// it did not reach the reset threshold rather than lying about it.
		const messages = [text(40), text(40), text(500_000)]

		expect(__naiveKeepStartByTokensForTests(messages, 100)).toBe(2)
	})

	it('checks the budget before adding, not after', () => {
		// Adding first and trimming afterwards admits exactly one oversized
		// message on every run — the failure mode is invisible because the
		// tail still looks bounded, just always by one message too many.
		// 1_000 tokens is 4_000 chars: two 2_000-char messages fit, a third
		// does not.
		const messages = [text(2_000), text(2_000), text(2_000)]

		expect(__naiveKeepStartByTokensForTests(messages, 1_000)).toBe(1)
	})

	it('keeps the whole history when the budget covers it', () => {
		const messages = [text(40), text(40), text(40)]

		expect(__naiveKeepStartByTokensForTests(messages, 8_000)).toBe(0)
	})
})

describe('the config knob', () => {
	it('is absent by default, so the count path is unchanged', () => {
		// Making the token path unconditional would change the retained tail
		// of every existing run without anyone asking for it.
		const parsed = CompactionConfigSchema.parse({})

		expect(parsed.keepRecentTokens).toBeUndefined()
		expect(parsed.keepRecentMessages).toBe(4)
	})

	it('accepts a positive integer and rejects zero', () => {
		expect(CompactionConfigSchema.parse({ keepRecentTokens: 8_000 }).keepRecentTokens).toBe(8_000)
		expect(() => CompactionConfigSchema.parse({ keepRecentTokens: 0 })).toThrow()
	})
})
