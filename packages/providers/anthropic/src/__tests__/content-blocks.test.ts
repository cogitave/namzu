import { describe, expect, it } from 'vitest'

import type { ChatCompletionParams } from '@namzu/sdk'
import { toAnthropicMessages } from '../client.js'

/**
 * Three signals used to die at this exact boundary:
 *
 * 1. `is_error` was computed by the executor, routed to the SSE bridge, the
 *    A2A bridge and the TUI, then dropped here — so the model's trained
 *    tool-failure recovery path never fired.
 * 2. Tool results were stringified, so a `computer-use` screenshot arrived
 *    as base64 TEXT and the model could not see it.
 * 3. The assistant turn was REBUILT as `[text?, ...tool_use]`, discarding
 *    any thinking block and its signature — exactly the pattern Anthropic's
 *    verbatim-echo contract prohibits when a `tool_result` follows.
 */

function messages(list: unknown[]): ChatCompletionParams['messages'] {
	return list as ChatCompletionParams['messages']
}

/** Anthropic flushes consecutive tool results into one user turn. */
function firstToolResult(out: ReturnType<typeof toAnthropicMessages>) {
	for (const msg of out) {
		if (Array.isArray(msg.content)) {
			const block = msg.content.find((b) => b.type === 'tool_result')
			if (block) return block as unknown as Record<string, unknown>
		}
	}
	return undefined
}

describe('tool results carry their failure signal', () => {
	it('sets is_error when the result failed', () => {
		const out = toAnthropicMessages(
			messages([
				{ role: 'assistant', content: null, toolCalls: [] },
				{ role: 'tool', content: 'Error: no such file', toolCallId: 'c1', isError: true },
			]),
		)
		expect(firstToolResult(out)).toMatchObject({ is_error: true, content: 'Error: no such file' })
	})

	it('omits is_error on success rather than sending false', () => {
		const out = toAnthropicMessages(
			messages([{ role: 'tool', content: 'ok', toolCallId: 'c1', isError: false }]),
		)
		expect(firstToolResult(out)).not.toHaveProperty('is_error')
	})
})

describe('tool results carry non-text content', () => {
	it('maps an image block to an Anthropic image block', () => {
		const out = toAnthropicMessages(
			messages([
				{
					role: 'tool',
					toolCallId: 'c1',
					content: [
						{ type: 'text', text: 'Screenshot captured.' },
						{ type: 'image', data: 'AAAA', mediaType: 'image/png' },
					],
				},
			]),
		)

		const result = firstToolResult(out)
		expect(Array.isArray(result?.content)).toBe(true)
		const blocks = result?.content as unknown as Array<Record<string, unknown>>
		expect(blocks[0]).toMatchObject({ type: 'text', text: 'Screenshot captured.' })
		expect(blocks[1]).toMatchObject({
			type: 'image',
			source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
		})
	})

	it('keeps a plain string a plain string — the cache prefix must not move', () => {
		const out = toAnthropicMessages(messages([{ role: 'tool', content: 'plain', toolCallId: 'c1' }]))
		expect(firstToolResult(out)?.content).toBe('plain')
	})

	it('never emits an empty content array, which Anthropic rejects', () => {
		const out = toAnthropicMessages(messages([{ role: 'tool', content: [], toolCallId: 'c1' }]))
		expect(firstToolResult(out)?.content).toBe('(no content)')
	})
})

describe('assistant turns echo reasoning verbatim', () => {
	it('emits thinking blocks FIRST, with the signature intact', () => {
		const out = toAnthropicMessages(
			messages([
				{
					role: 'assistant',
					content: 'Let me check.',
					reasoning: [{ type: 'thinking', text: 'the file is probably stale', signature: 'sig-abc' }],
					toolCalls: [
						{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
					],
				},
			]),
		)

		const blocks = out[0]?.content as unknown as Array<Record<string, unknown>>
		// Order is load-bearing: thinking, then text, then tool_use.
		expect(blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use'])
		expect(blocks[0]).toMatchObject({
			type: 'thinking',
			thinking: 'the file is probably stale',
			signature: 'sig-abc',
		})
	})

	it('replays a redacted block by its opaque payload', () => {
		const out = toAnthropicMessages(
			messages([
				{
					role: 'assistant',
					content: null,
					reasoning: [{ type: 'redacted_thinking', encrypted: 'opaque-payload' }],
					toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
				},
			]),
		)

		const blocks = out[0]?.content as unknown as Array<Record<string, unknown>>
		expect(blocks[0]).toMatchObject({ type: 'redacted_thinking', data: 'opaque-payload' })
	})

	it('is unchanged for an assistant turn with no reasoning', () => {
		const out = toAnthropicMessages(
			messages([
				{
					role: 'assistant',
					content: 'hi',
					toolCalls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
				},
			]),
		)
		const blocks = out[0]?.content as unknown as Array<Record<string, unknown>>
		expect(blocks.map((b) => b.type)).toEqual(['text', 'tool_use'])
	})
})
