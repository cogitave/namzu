import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toAnthropicMessages } from '../client.js'

/**
 * This driver built an image block by calling `String()` on whatever
 * `data` and `mediaType` happened to be, with only a truthiness check
 * behind it. A non-string `data` therefore became the literal
 * `"[object Object]"` or `"undefined"` as the base64 payload — a request
 * the wire rejects, with nothing in the rejection naming the block at
 * fault.
 *
 * That is reachable: a remote tool result is cast without validation on
 * the way in, and `data` is only typed as a string by convention. The
 * sibling driver next door already type- and media-type-guards, and
 * degrades an unsupported block to a named placeholder rather than
 * smuggling its payload through as text. This one now does the same.
 */

function messages(list: unknown[]): ChatCompletionParams['messages'] {
	return list as ChatCompletionParams['messages']
}

function toolResultContent(content: unknown): unknown[] | string | undefined {
	const out = toAnthropicMessages(
		messages([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [{ id: 't1', function: { name: 'shot' } }] },
			{ role: 'tool', toolCallId: 't1', content },
		]),
	)
	for (const msg of out) {
		if (!Array.isArray(msg.content)) continue
		const block = msg.content.find((b) => b.type === 'tool_result') as
			| { content?: unknown[] | string }
			| undefined
		if (block) return block.content
	}
	return undefined
}

const asBlocks = (content: unknown): Record<string, unknown>[] =>
	Array.isArray(content) ? (content as Record<string, unknown>[]) : []

describe('an image block', () => {
	it('goes through when it is well-formed', () => {
		const blocks = asBlocks(
			toolResultContent([{ type: 'image', data: 'aGk=', mediaType: 'image/png' }]),
		)
		expect(blocks[0]).toMatchObject({
			type: 'image',
			source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
		})
	})

	it('is named, not stringified, when data is not a string', () => {
		// `String({})` is `"[object Object]"`. Sending that as base64 gets
		// the WHOLE request rejected, and the rejection says nothing about
		// which block caused it.
		const blocks = asBlocks(
			toolResultContent([{ type: 'image', data: { buffer: [1, 2] }, mediaType: 'image/png' }]),
		)
		expect(blocks[0]?.type).toBe('text')
		expect(String(blocks[0]?.text)).not.toContain('[object Object]')
		expect(String(blocks[0]?.text)).toMatch(/omitted/)
	})

	it('is named when the media type is one this wire does not accept', () => {
		const blocks = asBlocks(
			toolResultContent([{ type: 'image', data: 'aGk=', mediaType: 'image/tiff' }]),
		)
		expect(blocks[0]?.type).toBe('text')
		expect(String(blocks[0]?.text)).toContain('image/tiff')
	})

	it('is named when the media type is missing entirely', () => {
		const blocks = asBlocks(toolResultContent([{ type: 'image', data: 'aGk=' }]))
		expect(blocks[0]?.type).toBe('text')
	})

	it('does not inline the payload it refused to send', () => {
		// Dumping base64 in as text costs thousands of tokens to say nothing
		// the model can read — the exact failure the block channel exists to
		// avoid.
		const payload = 'A'.repeat(5_000)
		const blocks = asBlocks(
			toolResultContent([{ type: 'image', data: payload, mediaType: 'image/tiff' }]),
		)
		expect(String(blocks[0]?.text)).not.toContain(payload)
		// It still says how big the thing was, so the omission is legible.
		expect(String(blocks[0]?.text)).toContain('5000')
	})
})

describe('a document block', () => {
	it('goes through when it is well-formed', () => {
		const blocks = asBlocks(
			toolResultContent([
				{ type: 'document', data: 'JVBE', mediaType: 'application/pdf', name: 'report.pdf' },
			]),
		)
		expect(blocks[0]).toMatchObject({ type: 'document', title: 'report.pdf' })
	})

	it('is named when its media type is not one this wire accepts', () => {
		const blocks = asBlocks(
			toolResultContent([{ type: 'document', data: 'x', mediaType: 'application/zip' }]),
		)
		expect(blocks[0]?.type).toBe('text')
	})
})

describe('the rest of the contract is unchanged', () => {
	it('leaves a plain string alone', () => {
		expect(toolResultContent('just text')).toBe('just text')
	})

	it('keeps text blocks', () => {
		const blocks = asBlocks(toolResultContent([{ type: 'text', text: 'hello' }]))
		expect(blocks[0]).toEqual({ type: 'text', text: 'hello' })
	})

	it('still says something when everything was refused', () => {
		// The wire rejects an empty content array.
		const content = toolResultContent([])
		expect(content).toBe('(no content)')
	})
})
