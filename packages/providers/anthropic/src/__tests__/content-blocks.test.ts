import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * A tool result carrying an image used to be `JSON.stringify`d.
 *
 * So a screenshot reached the model as a wall of quoted base64 — the exact
 * thing the SDK's degrade helper exists to prevent, and pure waste besides:
 * the model paid for every character and could read none of them. This wire
 * carries image blocks inside a tool result natively; the mapper simply
 * never used the shape.
 *
 * The degrade path still matters for what this wire genuinely cannot take.
 * A document inside a tool result becomes the named placeholder rather than
 * an invented image block, because the wrong block fails the whole request
 * instead of just that part of it.
 */

const PNG = 'iVBORw0KGgo='

function bodyCapturer() {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async (body: Record<string, unknown>) => {
				seen.body = body
				return (async function* () {
					yield { type: 'message_start', message: { id: 'msg_1' } }
				})()
			}),
		},
	}
	return { provider, seen }
}

async function toolResultFor(content: unknown): Promise<Record<string, unknown>> {
	const { provider, seen } = bodyCapturer()
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [
			{ role: 'user', content: 'take a shot' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'call_1', content },
		],
	} as unknown as ChatCompletionParams)) {
		// drain
	}
	const messages = seen.body?.messages as Array<{ content: Array<Record<string, unknown>> }>
	const block = messages
		.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
		.find((b) => b.type === 'tool_result')
	return block ?? {}
}

describe('an image in a tool result is sent as an image', () => {
	it('carries the payload as a native image block', async () => {
		const result = await toolResultFor([
			{ type: 'text', text: 'captured' },
			{ type: 'image', mediaType: 'image/png', data: PNG },
		])
		const blocks = result.content as Array<Record<string, unknown>>

		expect(blocks.find((b) => b.type === 'image')?.source).toEqual({
			type: 'base64',
			media_type: 'image/png',
			data: PNG,
		})
	})

	it('does not stringify the payload into text', async () => {
		const result = await toolResultFor([{ type: 'image', mediaType: 'image/png', data: PNG }])

		// The bug in one assertion: the content used to be a JSON string
		// with the base64 quoted inside it.
		expect(typeof result.content).not.toBe('string')
		expect(JSON.stringify(result.content)).not.toContain('\\"data\\"')
	})

	it('keeps the text alongside the image, in order', async () => {
		const result = await toolResultFor([
			{ type: 'text', text: 'captured' },
			{ type: 'image', mediaType: 'image/png', data: PNG },
		])
		const blocks = result.content as Array<Record<string, unknown>>

		expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
		expect(blocks[0]?.text).toBe('captured')
	})

	it('carries several images', async () => {
		const result = await toolResultFor([
			{ type: 'image', mediaType: 'image/png', data: PNG },
			{ type: 'image', mediaType: 'image/jpeg', data: 'other' },
		])
		const blocks = result.content as Array<Record<string, unknown>>

		expect(blocks.filter((b) => b.type === 'image')).toHaveLength(2)
	})
})

describe('what this wire cannot carry degrades to a named placeholder', () => {
	it('describes a document rather than inventing an image block', async () => {
		const result = await toolResultFor([
			{ type: 'document', mediaType: 'application/pdf', data: 'JVBER', name: 'lease.pdf' },
		])
		const blocks = result.content as Array<Record<string, unknown>>

		expect(blocks[0]?.type).toBe('text')
		expect(blocks[0]?.text).toContain('lease.pdf')
		expect(blocks[0]?.text).toContain('application/pdf')
		// A block the wire rejects fails the request, not just the block.
		expect(blocks.some((b) => b.type === 'image')).toBe(false)
	})

	it('says how big it was, so the model knows what it is missing', async () => {
		const result = await toolResultFor([
			{ type: 'document', mediaType: 'application/pdf', data: 'A'.repeat(4096) },
		])
		const blocks = result.content as Array<Record<string, unknown>>

		expect(blocks[0]?.text).toMatch(/\d+(\.\d+)? (B|KB|MB)/)
	})
})

describe('the plain cases are unchanged', () => {
	it('sends a string result as a string', async () => {
		expect(await toolResultFor('just text')).toMatchObject({ content: 'just text' })
	})

	it('sends text-only blocks as a text block', async () => {
		const result = await toolResultFor([{ type: 'text', text: 'only words' }])
		const blocks = result.content as Array<Record<string, unknown>>

		expect(blocks).toEqual([{ type: 'text', text: 'only words' }])
	})

	it('sends an empty string rather than an empty array, which is rejected', async () => {
		expect(await toolResultFor([])).toMatchObject({ content: '' })
	})

	it('keeps the tool call id it answers', async () => {
		expect(await toolResultFor('x')).toMatchObject({ tool_use_id: 'call_1' })
	})
})
