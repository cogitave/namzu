import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The whole citation path existed except the two ends that touch a real
 * provider.
 *
 * The SDK had the `Citation` type, the stream chunk carried a slot for it,
 * the run's stream aggregator collected them onto the assistant message,
 * and the iteration attached them to the turn. Only the mock provider ever
 * emitted one. This driver neither asked for citations nor parsed them, so
 * in a real run the slot was always empty: an answer about a contract
 * arrived as prose, and checking it meant reading the contract again.
 *
 * The location stays a union on purpose. A provider that segments by
 * character offset has no page number, and inventing one would make an
 * uncheckable citation look checkable.
 */

const PDF = 'JVBERi0xLjQKJSVFT0Y='

function providerOver(
	events: unknown[],
	seen: { body?: Record<string, unknown> } = {},
): AnthropicProvider {
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
	const provider = providerOver(events)
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'q' }],
	} as ChatCompletionParams)) {
		out.push(chunk)
	}
	return out
}

function citationEvent(citation: Record<string, unknown>): unknown {
	return {
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'citations_delta', citation },
	}
}

const PAGE_CITATION = {
	type: 'page_location',
	cited_text: 'the term is five years',
	document_index: 0,
	document_title: 'lease.pdf',
	start_page_number: 3,
	end_page_number: 3,
}

describe('a cited passage reaches the caller', () => {
	it('emits the citation on the chunk delta', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent(PAGE_CITATION),
			{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
		])

		const cited = chunks.find((c) => c.delta.citation)?.delta.citation
		expect(cited?.citedText).toBe('the term is five years')
		expect(cited?.documentIndex).toBe(0)
		expect(cited?.documentTitle).toBe('lease.pdf')
		expect(cited?.location).toEqual({ kind: 'page', start: 3, end: 3 })
	})

	it('does not emit it as text — a citation is not prose', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent(PAGE_CITATION),
		])

		expect(chunks.some((c) => c.delta.content)).toBe(false)
	})

	it('reads a character-offset citation as char, not as a page', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent({
				cited_text: 'clause 4',
				document_index: 1,
				start_char_index: 120,
				end_char_index: 148,
			}),
		])

		expect(chunks.find((c) => c.delta.citation)?.delta.citation?.location).toEqual({
			kind: 'char',
			start: 120,
			end: 148,
		})
	})

	it('reads a block citation as block', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent({
				cited_text: 'row 7',
				document_index: 0,
				start_block_index: 7,
				end_block_index: 8,
			}),
		])

		expect(chunks.find((c) => c.delta.citation)?.delta.citation?.location).toEqual({
			kind: 'block',
			start: 7,
			end: 8,
		})
	})

	it('carries several citations through in order', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent({ ...PAGE_CITATION, cited_text: 'first' }),
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' and ' } },
			citationEvent({ ...PAGE_CITATION, cited_text: 'second' }),
		])

		expect(chunks.filter((c) => c.delta.citation).map((c) => c.delta.citation?.citedText)).toEqual([
			'first',
			'second',
		])
	})
})

describe('a citation that cannot be checked is dropped, not guessed', () => {
	it('drops one with no location, rather than inventing a page', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent({ cited_text: 'somewhere', document_index: 0 }),
		])

		// A citation that looks checkable and is not is worse than none:
		// the reader follows it to a page number nobody measured.
		expect(chunks.some((c) => c.delta.citation)).toBe(false)
	})

	it('drops one with no text', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent({ document_index: 0, start_page_number: 1, end_page_number: 1 }),
		])

		expect(chunks.some((c) => c.delta.citation)).toBe(false)
	})

	it('leaves the rest of the stream intact around a dropped one', async () => {
		const chunks = await chunksOf([
			{ type: 'message_start', message: { id: 'msg_1' } },
			citationEvent({ cited_text: 'no location' }),
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } },
			{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
		])

		expect(chunks.map((c) => c.delta.content).filter(Boolean)).toEqual(['answer'])
		expect(chunks.at(-1)?.finishReason).toBe('stop')
	})
})

describe('citations are requested only when the caller asked to check the answer', () => {
	async function documentBlockFor(citations?: boolean): Promise<Record<string, unknown>> {
		const seen: { body?: Record<string, unknown> } = {}
		const provider = providerOver([{ type: 'message_start', message: { id: 'm' } }], seen)
		for await (const _chunk of provider.chatStream({
			model: 'm',
			messages: [
				{
					role: 'user',
					content: 'summarize',
					attachments: [
						{
							type: 'document',
							data: PDF,
							mediaType: 'application/pdf',
							...(citations !== undefined ? { citations } : {}),
						},
					],
				},
			],
		} as unknown as ChatCompletionParams)) {
			// drain
		}
		const messages = seen.body?.messages as Array<{ content: Array<Record<string, unknown>> }>
		return messages[0]?.content.find((b) => b.type === 'document') ?? {}
	}

	it('enables them when the attachment asked for them', async () => {
		expect(await documentBlockFor(true)).toMatchObject({ citations: { enabled: true } })
	})

	it('leaves them off by default — they are not free', async () => {
		expect(await documentBlockFor()).not.toHaveProperty('citations')
	})

	it('leaves them off when explicitly declined', async () => {
		expect(await documentBlockFor(false)).not.toHaveProperty('citations')
	})
})
