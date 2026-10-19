import { describe, expect, it, vi } from 'vitest'

import type { SessionEventDraft } from '../../runtime/query/events.js'
import { streamProviderTurn } from '../../runtime/query/iteration/stream-turn.js'
import type { TurnId } from '../../types/ids/index.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import type { SessionEvent } from '../../types/session/index.js'
import type { Logger } from '../../utils/logger.js'
import { withProviderRetry } from '../retry.js'

/**
 * A stream that has yielded only reasoning has shown the consumer nothing it
 * cannot take back, so a connection reset there is retried like a failure
 * before the first chunk. Text and tool calls keep the old rule.
 */

const PARAMS = { model: 'm', messages: [] } as unknown as ChatCompletionParams
const TURN_ID = '99b1ceae-1a8b-4b07-b56e-327eae34f058' as TurnId

const reasoning = (text: string): StreamChunk => ({
	id: 'r',
	delta: { reasoning: { index: 0, type: 'thinking', text } },
})
const reset = () => Object.assign(new TypeError('terminated'), { code: 'ECONNRESET' })
const sleepFn = async () => {}

/** Attempt N yields `attempts[N]`'s chunks, then throws if it ends in an Error. */
function scripted(attempts: Array<Array<StreamChunk | Error>>): LLMProvider & { calls: number } {
	let calls = 0
	return {
		id: 'scripted',
		name: 'Scripted',
		capabilities: {},
		get calls() {
			return calls
		},
		async *chatStream() {
			const step = attempts[Math.min(calls, attempts.length - 1)] ?? []
			calls++
			for (const item of step) {
				if (item instanceof Error) throw item
				yield item
			}
		},
	} as unknown as LLMProvider & { calls: number }
}

async function collect(provider: LLMProvider): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const c of provider.chatStream(PARAMS)) out.push(c)
	return out
}

describe('a stream that fails after reasoning only', () => {
	it('is retried, and the second attempt finishes normally', async () => {
		const inner = scripted([
			[reasoning('x'), reset()],
			[
				{ id: 'b', delta: { content: 'answer' } },
				{ id: 'b', delta: {}, finishReason: 'stop' },
			],
		])
		const provider = withProviderRetry(inner, {
			config: { maxRetries: 3 },
			sleepFn,
			random: () => 0,
		})
		const chunks = await collect(provider)
		expect(inner.calls).toBe(2)
		const notice = chunks.find((c) => c.retry)?.retry
		expect(notice).toMatchObject({ attempt: 1, maxRetries: 3, restart: true })
		expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(['answer'])
	})

	it('is retried without retryMidStream, which stays off by default', async () => {
		const inner = scripted([[reasoning('x'), reset()], [{ id: 'b', delta: { content: 'ok' } }]])
		await collect(
			withProviderRetry(inner, {
				config: { maxRetries: 3, retryMidStream: false },
				sleepFn,
			}),
		)
		expect(inner.calls).toBe(2)
	})

	it('gives up after maxRetries when it keeps failing', async () => {
		const inner = scripted([[reasoning('x'), reset()]])
		await expect(
			collect(withProviderRetry(inner, { config: { maxRetries: 2 }, sleepFn })),
		).rejects.toMatchObject({ code: 'network' })
		expect(inner.calls).toBe(3)
	})

	it('is not retried once a text delta came before the error', async () => {
		const inner = scripted([[reasoning('x'), { id: 'a', delta: { content: 'par' } }, reset()]])
		await expect(
			collect(withProviderRetry(inner, { config: { maxRetries: 3 }, sleepFn })),
		).rejects.toMatchObject({ code: 'network' })
		expect(inner.calls).toBe(1)
	})

	it('is not retried once a tool-call delta came before the error', async () => {
		const inner = scripted([
			[
				reasoning('x'),
				{
					id: 'a',
					delta: { toolCalls: [{ index: 0, id: 't1', function: { name: 'x', arguments: '{' } }] },
				},
				reset(),
			],
		])
		await expect(
			collect(
				withProviderRetry(inner, {
					config: { maxRetries: 3, retryMidStream: true },
					sleepFn,
				}),
			),
		).rejects.toMatchObject({ code: 'network' })
		expect(inner.calls).toBe(1)
	})

	it('control: a throw before anything is yielded is retried up to maxRetries, with no restart', async () => {
		const inner = scripted([[reset()]])
		const seen: StreamChunk[] = []
		const provider = withProviderRetry(inner, { config: { maxRetries: 3 }, sleepFn })
		await expect(
			(async () => {
				for await (const c of provider.chatStream(PARAMS)) seen.push(c)
			})(),
		).rejects.toMatchObject({ code: 'network' })
		expect(inner.calls).toBe(4)
		expect(seen.filter((c) => c.retry).every((c) => c.retry?.restart === undefined)).toBe(true)
	})
})

describe('the turn after a reasoning-only cut', () => {
	function makeLogger(): Logger {
		const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
		return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
	}

	it('keeps exactly one reasoning block, the second attempt', async () => {
		const inner = scripted([
			[reasoning('first attempt'), reset()],
			[
				reasoning('second attempt'),
				{ id: 'b', delta: { content: 'answer' } },
				{ id: 'b', delta: {}, finishReason: 'stop' },
			],
		])
		const provider = withProviderRetry(inner, { config: { maxRetries: 3 }, sleepFn })
		const events: SessionEvent[] = []
		const pending: SessionEvent[] = []
		const emitEvent = async (e: SessionEventDraft) => {
			events.push(e as SessionEvent)
			pending.push(e as SessionEvent)
		}
		const drainPending = function* (): Generator<SessionEvent> {
			while (pending.length > 0) {
				const next = pending.shift()
				if (next) yield next
			}
		}
		const gen = streamProviderTurn(
			provider,
			{ model: 'm', messages: [] } as never,
			emitEvent,
			drainPending,
			TURN_ID,
			1,
			false,
			makeLogger(),
		)
		let next = await gen.next()
		while (!next.done) next = await gen.next()
		const message = next.value.response.message
		expect(message.content).toBe('answer')
		expect(message.reasoning).toHaveLength(1)
		expect(message.reasoning?.[0]?.text).toBe('second attempt')
		expect(events.find((e) => e.type === 'provider_retry')).toMatchObject({ restart: true })
	})
})
