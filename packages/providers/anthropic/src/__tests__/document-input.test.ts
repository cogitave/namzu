import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { ANTHROPIC_CAPABILITIES, AnthropicProvider } from '../client.js'

/**
 * The driver declared `supportsDocuments: true` and had no document branch.
 *
 * Every attachment was mapped as an image block carrying the attachment's
 * media type, so a PDF went up as `{ type: 'image', source: { media_type:
 * 'application/pdf' } }` — a shape the API rejects. The capability set said
 * documents worked, the SDK carried a `DocumentAttachment` type with a page
 * of documentation about why native handling is worth having, and the one
 * line that would have used it was never written.
 *
 * The native block is not a nicety: it buys page structure, the provider's
 * own extraction, and the citations that make an answer checkable.
 */

const PDF = 'JVBERi0xLjQKJSVFT0Y='

function providerCapturing(seen: { body?: Record<string, unknown> }): AnthropicProvider {
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	// The vendor client is the only seam; replace its one method.
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async (body: Record<string, unknown>) => {
				seen.body = body
				return (async function* () {
					yield { type: 'message_start', message: { id: 'msg_1' } }
					yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
				})()
			}),
		},
	}
	return provider
}

async function bodyFor(params: Partial<ChatCompletionParams>): Promise<Record<string, unknown>> {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = providerCapturing(seen)
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'summarize this' }],
		...params,
	} as ChatCompletionParams)) {
		// drain
	}
	return seen.body ?? {}
}

/** The first user message's content blocks, as sent. */
function blocksOf(body: Record<string, unknown>): Record<string, unknown>[] {
	const messages = body.messages as Array<{ content: unknown }>
	return messages[0]?.content as Record<string, unknown>[]
}

function withAttachments(attachments: unknown[]): Partial<ChatCompletionParams> {
	return {
		messages: [{ role: 'user', content: 'summarize this', attachments }],
	} as unknown as Partial<ChatCompletionParams>
}

describe('a document attachment reaches the wire as a document', () => {
	it('sends a document block, not an image block', async () => {
		const body = await bodyFor(
			withAttachments([{ type: 'document', data: PDF, mediaType: 'application/pdf' }]),
		)

		const doc = blocksOf(body).find((b) => b.type === 'document')
		expect(doc?.source).toEqual({ type: 'base64', media_type: 'application/pdf', data: PDF })
		// The bug in one assertion: it used to be an image block.
		expect(blocksOf(body).some((b) => b.type === 'image')).toBe(false)
	})

	it('keeps the prose ahead of the document', async () => {
		const body = await bodyFor(
			withAttachments([{ type: 'document', data: PDF, mediaType: 'application/pdf' }]),
		)

		expect(blocksOf(body)[0]).toMatchObject({ type: 'text', text: 'summarize this' })
	})

	it('carries the name so the model can refer to the file', async () => {
		const body = await bodyFor(
			withAttachments([
				{ type: 'document', data: PDF, mediaType: 'application/pdf', name: 'lease.pdf' },
			]),
		)

		expect(blocksOf(body).find((b) => b.type === 'document')?.title).toBe('lease.pdf')
	})

	it('omits the title when the caller supplied no name', async () => {
		const body = await bodyFor(
			withAttachments([{ type: 'document', data: PDF, mediaType: 'application/pdf' }]),
		)

		expect(blocksOf(body).find((b) => b.type === 'document')).not.toHaveProperty('title')
	})

	it('still maps an image attachment as an image', async () => {
		const body = await bodyFor(
			withAttachments([{ type: 'image', data: 'AAAA', mediaType: 'image/png' }]),
		)

		expect(blocksOf(body).find((b) => b.type === 'image')?.source).toEqual({
			type: 'base64',
			media_type: 'image/png',
			data: 'AAAA',
		})
		expect(blocksOf(body).some((b) => b.type === 'document')).toBe(false)
	})

	it('carries both kinds in one message, in the order given', async () => {
		const body = await bodyFor(
			withAttachments([
				{ type: 'document', data: PDF, mediaType: 'application/pdf' },
				{ type: 'image', data: 'AAAA', mediaType: 'image/png' },
			]),
		)

		expect(blocksOf(body).map((b) => b.type)).toEqual(['text', 'document', 'image'])
	})
})

describe('the capability claim matches the mapper', () => {
	it('declares document support, which is now true', () => {
		expect(ANTHROPIC_CAPABILITIES.supportsDocuments).toBe(true)
	})
})
