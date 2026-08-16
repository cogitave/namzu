import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import {
	type Message,
	createAssistantMessage,
	createToolMessage,
} from '../../types/message/index.js'
import { planCompaction } from '../plan.js'

/**
 * The compaction pass, asked without a run.
 *
 * The whole algorithm lived inside `runCompactionCheck` and read the live
 * message array, the logger and the event emitter off an iteration context.
 * So the only way to ask "would this history be cut, and where" was to
 * stand up a full run harness — which is also why every test of the
 * boundary math had to assert it through a model call.
 *
 * These call the arithmetic directly. What stayed behind is everything with
 * an effect; nothing here has one.
 */

const config = (over: Partial<CompactionConfig> = {}): CompactionConfig =>
	({
		strategy: 'structured',
		triggerThreshold: 0.7,
		keepRecentMessages: 2,
		clearToolResults: false,
		richStateThreshold: 100,
		llmVerification: false,
		...over,
	}) as CompactionConfig

const sys = (text: string): Message => ({ role: 'system', content: text }) as Message
const user = (text: string): Message => ({ role: 'user', content: text }) as Message
const asst = (text: string): Message => ({ role: 'assistant', content: text }) as Message
/** An assistant turn that called one tool, and the result that answers it. */
const callPair = (id: string, output: string): Message[] => [
	createAssistantMessage('', [
		{ id, type: 'function', function: { name: 'probe', arguments: '{}' } },
	]),
	createToolMessage(output, id),
]

function plan(messages: readonly Message[], over: Partial<CompactionConfig> = {}) {
	return planCompaction({
		messages,
		config: config(over),
		contextWindowTokens: 100_000,
		estimatedTokens: 90_000,
		skipToolResultClear: true,
	})
}

describe('a compaction pass can be planned without a run', () => {
	it('refuses a history with no leading system message', () => {
		// The permanent floor is what a summary is spliced beneath. Without
		// one there is nothing to preserve and no anchor for the result.
		const result = plan([user('a'), asst('b'), user('c'), asst('d')])

		expect(result).toEqual({ kind: 'skip', reason: 'no_system_floor' })
	})

	it('refuses a history shorter than the recent window plus a floor', () => {
		const result = plan([sys('s'), user('a')])

		expect(result).toEqual({ kind: 'skip', reason: 'too_few_messages' })
	})

	it('refuses when every candidate cut would split a tool pair', () => {
		// One assistant fanning out more calls than the recent window holds.
		// Cutting anyway leaves a `tool_result` with no matching `tool_use`
		// and the provider rejects the next turn — compaction killing the run
		// it exists to keep alive.
		const messages: Message[] = [sys('s'), ...callPair('t1', 'r1')]

		expect(plan(messages, { keepRecentMessages: 1 })).toEqual({
			kind: 'skip',
			reason: 'no_safe_cut',
		})
	})

	it('always leaves at least one older message when it plans a cut', () => {
		// `too_few_older` is in the union and cannot currently be produced:
		// the boundary search requires a candidate strictly past the system
		// floor, so `olderMessages` is never shorter than one, which is the
		// threshold. This asserts the property that makes it unreachable
		// rather than pretending to cover the branch — a test that produced
		// the reason by lowering some other knob would be testing a
		// configuration nothing ships.
		for (let extra = 0; extra < 6; extra++) {
			const messages = [sys('s'), ...Array.from({ length: extra + 3 }, (_, i) => user(`m${i}`))]
			const result = plan(messages)
			if (result.kind !== 'plan') continue
			expect(result.olderMessages.length, `${messages.length} messages`).toBeGreaterThanOrEqual(1)
		}
	})

	it('partitions a normal history without losing a message', () => {
		// The partition must reconstruct the input exactly. A boundary that
		// dropped one message would still produce three plausible arrays, and
		// every behavioural test downstream would keep passing — the loss
		// only shows as a summary that omits a turn nobody can point at.
		const messages = [sys('s1'), user('a'), asst('b'), user('c'), asst('d'), user('e')]
		const result = plan(messages)

		expect(result.kind).toBe('plan')
		if (result.kind !== 'plan') return
		expect([...result.systemMessages, ...result.olderMessages, ...result.recentMessages]).toEqual(
			messages,
		)
		// Snapped BACK from the naive boundary of 4 — `findSafeTrimIndex`
		// declined that index — which is the behaviour the whole tool-pair
		// guard exists for. Asserted as a number rather than recomputed, so a
		// change to the boundary search shows up here as a diff to review.
		expect(result.keepStart).toBe(3)
		expect(result.recentMessages.length).toBeGreaterThanOrEqual(2)
	})

	it('reports a tool-result clear rather than a cut, when one is available', () => {
		const big = 'x'.repeat(5_000)
		const messages: Message[] = [
			sys('s'),
			...callPair('t1', big),
			user('a'),
			asst('b'),
			user('c'),
			asst('d'),
		]

		const result = planCompaction({
			messages,
			config: config({ clearToolResults: true, keepRecentToolResults: 0 }),
			contextWindowTokens: 100_000,
			estimatedTokens: 2_000,
		})

		expect(result.kind).toBe('cleared')
		if (result.kind !== 'cleared') return
		expect(result.clearedCount).toBeGreaterThan(0)
		expect(result.charsReclaimed).toBeGreaterThan(0)
		// Length-preserving: only content changes, which is what lets the
		// caller write entries back into the live array element-wise.
		expect(result.messages).toHaveLength(messages.length)
	})

	it('does not call a forced pass relieved by a clear', () => {
		// A forced pass runs because the provider REJECTED the prompt, which
		// is a measurement. Answering it with the same estimate the provider
		// just refuted would declare success after clearing one result and
		// hand back a history that overflows again on the retry.
		const big = 'x'.repeat(5_000)
		const messages: Message[] = [sys('s'), ...callPair('t1', big), user('a'), asst('b')]
		const input = {
			messages,
			config: config({ clearToolResults: true, keepRecentToolResults: 0 }),
			contextWindowTokens: 100_000,
			estimatedTokens: 2_000,
		}

		const unforced = planCompaction(input)
		const forced = planCompaction({ ...input, force: true })

		expect(unforced.kind === 'cleared' && unforced.reliefWasEnough).toBe(true)
		expect(forced.kind === 'cleared' && forced.reliefWasEnough).toBe(false)
	})

	it('holds no reference to an iteration context', () => {
		// Grepped rather than asserted through behaviour, because a
		// reintroduced context read would compile, pass every test above, and
		// silently re-couple the arithmetic to a live run — which is the one
		// property this whole extraction exists to establish.
		const source = readFileSync(new URL('../plan.ts', import.meta.url), 'utf-8')

		expect(source).not.toMatch(/\bctx\./)
		expect(source).not.toMatch(/Iteration[C]ontext/)
	})
})
