/**
 * A member that keeps answering "overloaded" is left after a few answers when
 * the chain has another member, instead of spending its whole retry budget.
 * The clock is injected: every wait goes to a recording `sleepFn`, so no test
 * here depends on real time.
 */

import { describe, expect, it } from 'vitest'

import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { withProviderFallback } from '../fallback.js'
import { type ProviderRetryConfig, withProviderRetry } from '../retry.js'

const PARAMS = { model: 'primary-model', messages: [] } as unknown as ChatCompletionParams

function httpError(status: number) {
	return Object.assign(new Error(`HTTP ${status}`), { status })
}

/** Answers from a script of statuses (or `ok`), repeating the last entry. */
function scripted(id: string, script: Array<number | 'ok'>) {
	let calls = 0
	const provider = {
		id,
		name: id,
		async *chatStream(): AsyncIterable<StreamChunk> {
			const step = script[Math.min(calls, script.length - 1)]
			calls++
			if (step !== 'ok') throw httpError(step as number)
			yield { id: 'c', delta: { content: `answer from ${id}` } }
		},
	} as unknown as LLMProvider
	return { provider, calls: () => calls }
}

async function run(members: ReturnType<typeof scripted>[], config: Partial<ProviderRetryConfig>) {
	const waits: number[] = []
	const chain = withProviderFallback(
		members.map((m, i) => ({
			provider: withProviderRetry(m.provider, {
				config: {
					maxRetries: 10,
					...config,
					overloadedFallOverAfter: i < members.length - 1 ? config.overloadedFallOverAfter : 0,
				},
				sleepFn: async (ms) => {
					waits.push(ms)
				},
				random: () => 0.5,
			}),
		})),
	)
	const chunks: StreamChunk[] = []
	for await (const c of chain.chatStream(PARAMS)) chunks.push(c)
	const text = chunks.map((c) => c.delta.content ?? '').join('')
	return { chunks, text, waits }
}

describe('repeated overload leaves the member', () => {
	it('moves to the healthy second after exactly 3 attempts', async () => {
		const a = scripted('a', [529])
		const b = scripted('b', ['ok'])
		const { text, chunks, waits } = await run([a, b], { overloadedFallOverAfter: 3 })
		expect(text).toBe('answer from b')
		expect(a.calls()).toBe(3)
		expect(waits).toHaveLength(2)
		const notice = chunks.find((c) => c.fallback)?.fallback
		expect(notice?.code).toBe('overloaded')
		expect(notice?.reason).toContain('Left after 3 overloaded answers in a row')
		expect(notice?.fromProviderId).toBe('a')
		expect(notice?.toProviderId).toBe('b')
	})

	it('one overloaded answer then success stays on the same member', async () => {
		const a = scripted('a', [529, 'ok'])
		const b = scripted('b', ['ok'])
		const { text, chunks } = await run([a, b], { overloadedFallOverAfter: 3 })
		expect(text).toBe('answer from a')
		expect(a.calls()).toBe(2)
		expect(b.calls()).toBe(0)
		expect(chunks.some((c) => c.fallback)).toBe(false)
	})

	it('does not count rate limits', async () => {
		const a = scripted('a', [429, 429, 429, 429, 'ok'])
		const b = scripted('b', ['ok'])
		const { text } = await run([a, b], { overloadedFallOverAfter: 3 })
		expect(text).toBe('answer from a')
		expect(a.calls()).toBe(5)
		expect(b.calls()).toBe(0)
	})

	it('a different failure between overloaded answers restarts the count', async () => {
		const a = scripted('a', [529, 529, 500, 529, 529, 'ok'])
		const b = scripted('b', ['ok'])
		const { text } = await run([a, b], { overloadedFallOverAfter: 3 })
		expect(text).toBe('answer from a')
		expect(a.calls()).toBe(6)
	})

	it("at 0 keeps today's count: the whole budget, 11 attempts", async () => {
		const a = scripted('a', [529])
		const b = scripted('b', ['ok'])
		const { text } = await run([a, b], { overloadedFallOverAfter: 0 })
		expect(text).toBe('answer from b')
		expect(a.calls()).toBe(11)
	})

	it('a chain of one is untouched: the last member keeps the whole budget', async () => {
		const a = scripted('a', [529])
		await expect(run([a], { overloadedFallOverAfter: 3 })).rejects.toThrow('HTTP 529')
		expect(a.calls()).toBe(11)
	})

	it('without the option a bare retry never gives up early', async () => {
		const a = scripted('a', [529, 529, 529, 529, 'ok'])
		const wrapped = withProviderRetry(a.provider, {
			config: { maxRetries: 10 },
			sleepFn: async () => {},
		})
		for await (const _ of wrapped.chatStream(PARAMS)) {
			// drain
		}
		expect(a.calls()).toBe(5)
	})
})
