import { describe, expect, it, vi } from 'vitest'

import type { AssistantMessage, Message, ToolMessage } from '../../types/message/index.js'
import { createSlidingWindowReducer } from '../reducer.js'
import type { ContextReduction } from '../reducer.js'

/**
 * `strategy: 'sliding-window'` was accepted by the config schema and then
 * ignored — the runtime asked only whether the strategy was `'disabled'`, so
 * a host who chose the cheap non-LLM path silently got the expensive LLM one,
 * summarization calls and all. These pin the behaviour the name always
 * claimed, and the three invariants that make a shorter history usable rather
 * than merely shorter.
 */

const sys = (content: string): Message => ({ role: 'system', content, timestamp: 1 })
const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })
const asst = (content: string): Message => ({ role: 'assistant', content, timestamp: 1 })

const callsTool = (id: string): AssistantMessage => ({
	role: 'assistant',
	content: null,
	timestamp: 1,
	toolCalls: [{ id, type: 'function', function: { name: 'echo', arguments: '{}' } }],
})

const toolResult = (id: string): ToolMessage => ({
	role: 'tool',
	content: 'ok',
	timestamp: 1,
	toolCallId: id,
})

function reduction(
	messages: readonly Message[],
	over?: Partial<ContextReduction>,
): ContextReduction {
	return {
		messages,
		reason: 'threshold',
		estimatedTokens: 1_000,
		contextWindowTokens: 2_000,
		model: 'mock-model',
		keepRecentMessages: 4,
		...over,
	}
}

describe('the sliding window keeps recent turns and drops the rest', () => {
	it('keeps the configured tail', async () => {
		const reduce = createSlidingWindowReducer()
		const messages = [sys('prompt'), ...Array.from({ length: 10 }, (_, i) => user(`m${i}`))]

		const next = await reduce(reduction(messages))

		expect(next).toBeDefined()
		expect(next?.length).toBe(5) // the system floor plus keepRecentMessages
		expect(next?.at(-1)).toBe(messages.at(-1))
	})

	it('cuts harder when the provider already rejected the prompt', async () => {
		const reduce = createSlidingWindowReducer()
		const messages = [sys('prompt'), ...Array.from({ length: 10 }, (_, i) => user(`m${i}`))]

		const threshold = await reduce(reduction(messages))
		const overflow = await reduce(reduction(messages, { reason: 'overflow' }))

		// An overflow means the ordinary window was ALREADY too big. Cutting to
		// the same size would shed nothing and the caller would retry an
		// identical prompt.
		expect(overflow?.length).toBeLessThan(threshold?.length ?? 0)
	})

	it('summarizes nothing — every survivor is the original object', async () => {
		const reduce = createSlidingWindowReducer()
		const messages = [sys('prompt'), ...Array.from({ length: 8 }, (_, i) => user(`m${i}`))]

		const next = await reduce(reduction(messages))

		for (const message of next ?? []) expect(messages).toContain(message)
	})
})

describe('the three invariants a shorter history has to keep', () => {
	it('never drops the leading system floor', async () => {
		const reduce = createSlidingWindowReducer()
		const messages = [
			sys('prompt'),
			sys('working memory'),
			...Array.from({ length: 8 }, (_, i) => user(`m${i}`)),
		]

		const next = await reduce(reduction(messages))

		expect(next?.[0]).toBe(messages[0])
		expect(next?.[1]).toBe(messages[1])
	})

	it('does not split a tool_use from its tool_result', async () => {
		const reduce = createSlidingWindowReducer()
		// The naive cut at length-3 lands between the assistant call and its
		// result, which is a provider 400 on the next turn.
		const messages = [
			sys('prompt'),
			user('go'),
			asst('thinking'),
			callsTool('c1'),
			toolResult('c1'),
			user('again'),
			asst('done'),
			user('more'),
		]

		const next = await reduce(reduction(messages, { keepRecentMessages: 5 }))

		const kept = new Set(next ?? [])
		// Cutting at 3 would keep the call and its result together; cutting at
		// 4 would orphan the result. The pair is never split either way.
		expect(kept.has(messages[4] as Message)).toBe(kept.has(messages[3] as Message))
	})

	it('takes a cut above the requested window when nothing below is safe', async () => {
		const reduce = createSlidingWindowReducer()
		// A multi-step turn: the user is silent while the agent works, so every
		// boundary inside the recent window opens on an assistant or tool
		// message. A backwards-only search would decline here — exactly when
		// the history is longest.
		const messages = [
			sys('prompt'),
			user('go'),
			callsTool('c1'),
			toolResult('c1'),
			asst('working'),
			callsTool('c2'),
			toolResult('c2'),
			// The only user turn after the opening one, and it sits ABOVE the
			// requested cut — so every candidate below opens on an assistant or
			// tool message and the backwards search comes back empty.
			user('next'),
			callsTool('c3'),
			toolResult('c3'),
		]

		const next = await reduce(reduction(messages, { keepRecentMessages: 5 }))

		expect(next).toBeDefined()
		expect(next?.length).toBeLessThan(messages.length)
		// It kept LESS than asked rather than declining, and what it kept opens
		// on a user turn.
		expect(next?.[1]?.role).toBe('user')
	})

	it('keeps a pinned turn from the middle of the conversation', async () => {
		const reduce = createSlidingWindowReducer()
		const pinned: Message = { ...user('the account id is X'), retain: true }
		const messages = [
			sys('prompt'),
			user('m0'),
			pinned,
			...Array.from({ length: 8 }, (_, i) => user(`m${i + 1}`)),
		]

		const next = await reduce(reduction(messages))

		// Recency is not the only thing that matters, which is what `retain`
		// exists to say.
		expect(next).toContain(pinned)
		expect(next).not.toContain(messages[1])
	})
})

describe('refusing beats a reduction that would break the next turn', () => {
	it('declines when there is nothing but the system floor to cut', async () => {
		const reduce = createSlidingWindowReducer()

		expect(await reduce(reduction([sys('prompt'), user('go')]))).toBeUndefined()
	})

	it('declines when every candidate cut splits one assistant fan-out', async () => {
		const reduce = createSlidingWindowReducer()
		// Six results answering one call: no cut inside the block is safe, and
		// the condition clears itself on the next assistant message.
		const messages = [
			sys('prompt'),
			user('go'),
			{
				role: 'assistant',
				content: null,
				timestamp: 1,
				toolCalls: Array.from({ length: 6 }, (_, i) => ({
					id: `c${i}`,
					type: 'function' as const,
					function: { name: 'echo', arguments: '{}' },
				})),
			} as AssistantMessage,
			...Array.from({ length: 6 }, (_, i) => toolResult(`c${i}`)),
		]

		expect(await reduce(reduction(messages, { keepRecentMessages: 2 }))).toBeUndefined()
	})

	it('declines rather than reporting a reduction that removed nothing', async () => {
		const reduce = createSlidingWindowReducer()
		// Every non-system message is pinned, so the survivor set is the input.
		const messages = [
			sys('prompt'),
			...Array.from({ length: 8 }, (_, i) => ({ ...user(`m${i}`), retain: true })),
		]

		// Saying "reduced" here would have the overflow path retry an identical
		// prompt and burn a model call to be told the same thing.
		expect(await reduce(reduction(messages))).toBeUndefined()
	})
})

describe('the knob a caller reaches for', () => {
	it('lets an explicit window override the run config', async () => {
		const reduce = createSlidingWindowReducer({ keepRecentMessages: 2 })
		const messages = [sys('prompt'), ...Array.from({ length: 10 }, (_, i) => user(`m${i}`))]

		const next = await reduce(reduction(messages, { keepRecentMessages: 8 }))

		expect(next?.length).toBe(3)
	})

	it('is a plain function, so a host can wrap one', async () => {
		const inner = createSlidingWindowReducer()
		const seen = vi.fn()
		const reduce = async (input: ContextReduction) => {
			seen(input.reason)
			return inner(input)
		}
		const messages = [sys('prompt'), ...Array.from({ length: 8 }, (_, i) => user(`m${i}`))]

		await reduce(reduction(messages, { reason: 'overflow' }))

		expect(seen).toHaveBeenCalledWith('overflow')
	})
})
