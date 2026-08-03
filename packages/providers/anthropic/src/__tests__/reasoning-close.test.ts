import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * Extended thinking was fully specified in the SDK and entirely absent
 * from this driver.
 *
 * The stream chunk carried a `reasoning` channel whose own comment named
 * the bug — "`thinking_delta` and `signature_delta` fell through the
 * driver's `default: // ignore`" — the run's aggregator bucketed fragments
 * by index and closed them on `done`, and `ReasoningBlock` recorded the
 * signature with a note that replaying it unchanged is mandatory. The
 * driver requested no thinking, parsed none, and replayed none.
 *
 * The close matters as much as the content. A block is only complete once
 * its signature has arrived, and the signature arrives last: without a
 * `done` the aggregator cannot tell a finished block from one still
 * streaming, and a block replayed without its signature invalidates the
 * whole conversation upstream — not just that block.
 */

function providerOver(events: unknown[], seen: { body?: Record<string, unknown> } = {}) {
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async (body: Record<string, unknown>) => {
				seen.body = body
				return (async function* () {
					for (const event of events) yield event
				})()
			}),
		},
	}
	return provider
}

async function chunksOf(events: unknown[]): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const chunk of providerOver(events).chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'q' }],
	} as ChatCompletionParams)) {
		out.push(chunk)
	}
	return out
}

const THINKING_STREAM = [
	{ type: 'message_start', message: { id: 'msg_1' } },
	{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
	{
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'thinking_delta', thinking: 'step one' },
	},
	{
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'thinking_delta', thinking: ' then two' },
	},
	{
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'signature_delta', signature: 'sig-abc' },
	},
	{ type: 'content_block_stop', index: 0 },
	{ type: 'content_block_start', index: 1, content_block: { type: 'text' } },
	{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'the answer' } },
	{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
]

function reasoningOf(chunks: StreamChunk[]) {
	return chunks.map((c) => c.delta.reasoning).filter((r): r is NonNullable<typeof r> => Boolean(r))
}

describe('a reasoning block streams, then closes', () => {
	it('opens the block with its kind', async () => {
		const reasoning = reasoningOf(await chunksOf(THINKING_STREAM))

		expect(reasoning[0]).toMatchObject({ index: 0, type: 'thinking' })
	})

	it('carries each fragment through in order', async () => {
		const reasoning = reasoningOf(await chunksOf(THINKING_STREAM))

		expect(reasoning.map((r) => r.text).filter(Boolean)).toEqual(['step one', ' then two'])
	})

	it('carries the signature, which arrives once at the end', async () => {
		const reasoning = reasoningOf(await chunksOf(THINKING_STREAM))

		expect(reasoning.find((r) => r.signature)?.signature).toBe('sig-abc')
	})

	it('closes the block so the aggregator knows the signature has landed', async () => {
		const reasoning = reasoningOf(await chunksOf(THINKING_STREAM))

		expect(reasoning.at(-1)).toEqual({ index: 0, done: true })
	})

	it('closes it before the text block starts, not after', async () => {
		const chunks = await chunksOf(THINKING_STREAM)
		const closeAt = chunks.findIndex((c) => c.delta.reasoning?.done)
		const textAt = chunks.findIndex((c) => c.delta.content === 'the answer')

		expect(closeAt).toBeGreaterThan(-1)
		expect(closeAt).toBeLessThan(textAt)
	})

	it('does not leak reasoning into the visible text', async () => {
		const chunks = await chunksOf(THINKING_STREAM)

		expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(['the answer'])
	})

	it('groups two blocks by their own index', async () => {
		const reasoning = reasoningOf(
			await chunksOf([
				{ type: 'message_start', message: { id: 'm' } },
				{ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
				{ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'a' } },
				{ type: 'content_block_stop', index: 0 },
				{ type: 'content_block_start', index: 1, content_block: { type: 'thinking' } },
				{ type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'b' } },
				{ type: 'content_block_stop', index: 1 },
			]),
		)

		expect(reasoning.filter((r) => r.done).map((r) => r.index)).toEqual([0, 1])
	})

	it('carries a redacted block as an opaque payload rather than text', async () => {
		const reasoning = reasoningOf(
			await chunksOf([
				{ type: 'message_start', message: { id: 'm' } },
				{
					type: 'content_block_start',
					index: 0,
					content_block: { type: 'redacted_thinking', data: 'opaque-bytes' },
				},
				{ type: 'content_block_stop', index: 0 },
			]),
		)

		expect(reasoning[0]).toMatchObject({ type: 'redacted_thinking', encrypted: 'opaque-bytes' })
		expect(reasoning[0]?.text).toBeUndefined()
	})

	it('still closes a tool call, which shares the same stop event', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'm' } },
			{
				type: 'content_block_start',
				index: 0,
				content_block: { type: 'tool_use', id: 'call_1', name: 'read' },
			},
			{ type: 'content_block_stop', index: 0 },
		])

		expect(chunks.some((c) => c.delta.toolCallEnd?.id === 'call_1')).toBe(true)
	})
})

describe('thinking can be asked for', () => {
	async function bodyFor(thinking: unknown): Promise<Record<string, unknown>> {
		const seen: { body?: Record<string, unknown> } = {}
		const provider = providerOver([{ type: 'message_start', message: { id: 'm' } }], seen)
		for await (const _chunk of provider.chatStream({
			model: 'm',
			messages: [{ role: 'user', content: 'q' }],
			...(thinking !== undefined ? { thinking } : {}),
		} as ChatCompletionParams)) {
			// drain
		}
		return seen.body ?? {}
	}

	it('sends the budget the caller set', async () => {
		expect(await bodyFor({ type: 'enabled', budgetTokens: 4096 })).toMatchObject({
			thinking: { type: 'enabled', budget_tokens: 4096 },
		})
	})

	it('enables it without a budget when none was named', async () => {
		expect((await bodyFor({ type: 'enabled' })).thinking).toEqual({ type: 'enabled' })
	})

	it('can turn it off on a model where it is on by default', async () => {
		expect((await bodyFor({ type: 'disabled' })).thinking).toEqual({ type: 'disabled' })
	})

	it('says nothing at all when the caller did not ask', async () => {
		expect(await bodyFor(undefined)).not.toHaveProperty('thinking')
	})
})

describe('a reasoned turn is replayed verbatim on the next request', () => {
	async function messagesFor(assistant: Record<string, unknown>) {
		const seen: { body?: Record<string, unknown> } = {}
		const provider = providerOver([{ type: 'message_start', message: { id: 'm' } }], seen)
		for await (const _chunk of provider.chatStream({
			model: 'm',
			messages: [{ role: 'user', content: 'q' }, assistant, { role: 'user', content: 'and then?' }],
		} as unknown as ChatCompletionParams)) {
			// drain
		}
		return seen.body?.messages as Array<{ role: string; content: unknown }>
	}

	it('replays the block with its signature intact', async () => {
		const messages = await messagesFor({
			role: 'assistant',
			content: 'because of that',
			reasoning: [{ type: 'thinking', text: 'step one', signature: 'sig-abc' }],
		})
		const blocks = messages[1]?.content as Array<Record<string, unknown>>

		expect(blocks[0]).toEqual({ type: 'thinking', thinking: 'step one', signature: 'sig-abc' })
	})

	it('puts the reasoning first, as the wire requires', async () => {
		const messages = await messagesFor({
			role: 'assistant',
			content: 'because of that',
			reasoning: [{ type: 'thinking', text: 'step one', signature: 'sig' }],
		})
		const blocks = messages[1]?.content as Array<Record<string, unknown>>

		expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text'])
	})

	it('replays it ahead of a tool call too', async () => {
		const messages = await messagesFor({
			role: 'assistant',
			content: null,
			reasoning: [{ type: 'thinking', text: 'i should read it', signature: 'sig' }],
			toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }],
		})
		const blocks = messages[1]?.content as Array<Record<string, unknown>>

		expect(blocks.map((b) => b.type)).toEqual(['thinking', 'tool_use'])
	})

	it('replays a redacted block as its opaque payload', async () => {
		const messages = await messagesFor({
			role: 'assistant',
			content: 'answer',
			reasoning: [{ type: 'redacted_thinking', encrypted: 'opaque-bytes' }],
		})
		const blocks = messages[1]?.content as Array<Record<string, unknown>>

		expect(blocks[0]).toEqual({ type: 'redacted_thinking', data: 'opaque-bytes' })
	})

	it('leaves an assistant turn that did not reason as a plain string', async () => {
		const messages = await messagesFor({ role: 'assistant', content: 'just an answer' })

		expect(messages[1]?.content).toBe('just an answer')
	})
})
