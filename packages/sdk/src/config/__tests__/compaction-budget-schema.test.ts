/**
 * The BUDGET SCHEMA.
 *
 * Every compaction count used to be `z.number().positive()`. Zod's base number
 * check rejects only non-numbers and `NaN`, so `Infinity` and `0.5` both parsed.
 * These are counts of messages, characters, sentences and tokens: a non-integer
 * is meaningless, and `Infinity` does something worse than being meaningless —
 * it turns a bound into a no-op rather than an error. `truncateMessages` compares
 * `charCount > budget`, never true against `Infinity`, so the WHOLE older history
 * was pasted into the verification prompt.
 *
 * They are `.int().positive()` now. `Number.isInteger` is false for `Infinity`
 * and for any fraction, so one validator closes both. These tests are the guard:
 * every count is checked against both illegal shapes, and the documented
 * defaults are pinned so tightening the validator cannot have moved them.
 */

import { describe, expect, it } from 'vitest'

import { WorkingStateManager } from '../../compaction/manager.js'
import { buildVerifiedSummary } from '../../compaction/verifier.js'
import { type Message, createUserMessage } from '../../types/message/index.js'
import type { ChatCompletionParams } from '../../types/provider/chat.js'
import type { LLMProvider } from '../../types/provider/interface.js'
import type { StreamChunk } from '../../types/provider/stream.js'
import { CompactionConfigSchema, RuntimeConfigSchema } from '../runtime.js'

/** Every integer count on CompactionConfigSchema. */
const COUNT_FIELDS = [
	'contextWindowTokens',
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

describe('CompactionConfigSchema — count fields', () => {
	for (const field of COUNT_FIELDS) {
		it(`rejects Infinity for ${field}`, () => {
			expect(() => CompactionConfigSchema.parse({ [field]: Number.POSITIVE_INFINITY })).toThrow()
		})

		it(`rejects a fractional value for ${field}`, () => {
			expect(() => CompactionConfigSchema.parse({ [field]: 0.5 })).toThrow()
		})
	}

	it('rejects Infinity through the RuntimeConfigSchema envelope', () => {
		expect(() =>
			RuntimeConfigSchema.parse({ compaction: { convoTextBudget: Number.POSITIVE_INFINITY } }),
		).toThrow()
	})

	it('still accepts the documented defaults', () => {
		const parsed = CompactionConfigSchema.parse({})
		expect(parsed.convoTextBudget).toBe(12_000)
		expect(parsed.keepRecentMessages).toBe(4)
	})
})

/**
 * Why the schema is the only defence, and what that leaves open.
 *
 * `truncateMessages` bounds the verification prompt with `charCount > budget`,
 * which is never true against `Infinity` — that is the consequence the schema
 * fix above exists to prevent, and it can no longer be reached THROUGH the
 * schema. It is still reachable by a host that hand-builds a `CompactionConfig`
 * object literal, because the inferred type is plain `number`; that is a stated
 * limitation, not a covered case. No silent clamp was added inside
 * `truncateMessages` — a budget that quietly repairs an illegal value hides the
 * caller's bug instead of surfacing it, and the schema is where the boundary
 * belongs.
 *
 * What this test does pin: with a LEGAL budget the prompt really is bounded, so
 * the truncation the schema now guarantees is actually performed.
 */
describe('truncateMessages bounds the verification prompt at a legal budget', () => {
	it('does not paste the entire older history into the verification prompt', async () => {
		const config = CompactionConfigSchema.parse({
			llmVerification: true,
			convoTextBudget: 12_000,
		})
		const manager = new WorkingStateManager(config)
		manager.setTask('write the quarterly report')

		const calls: ChatCompletionParams[] = []
		const provider: LLMProvider = {
			id: 'mock',
			name: 'mock',
			chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
				calls.push(params)
				return (async function* () {
					yield { id: 'c1', delta: { content: 'COMPLETE' } } as StreamChunk
				})()
			},
		}

		// ~200 KB of older history — far past any sane verification budget.
		const older: Message[] = Array.from({ length: 200 }, (_, i) =>
			createUserMessage(`turn ${i} ${'y'.repeat(1000)}`),
		)

		await buildVerifiedSummary(manager, older, provider, config)

		const promptChars = (calls[0]?.messages ?? []).reduce((n, m) => n + (m.content?.length ?? 0), 0)
		expect(promptChars).toBeLessThan(100_000)
	})
})
