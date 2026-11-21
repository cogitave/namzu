import type { ChatCompletionParams } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPENROUTER_CAPABILITIES, OpenRouterProvider } from '../client.js'

/**
 * An image a tool returns. A chat-completions tool message carries text only,
 * and each tool message must directly follow the assistant message that made
 * the calls, so the images ride in one user message after the last tool
 * message of that turn.
 */

type Wire = Array<{ role: string; content: unknown; tool_call_id?: string }>

function build(
	messages: ChatCompletionParams['messages'],
	extra: Partial<ChatCompletionParams> = {},
	provider = new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' }),
): Wire {
	return (
		provider as unknown as {
			buildRequestBody(p: ChatCompletionParams, s: boolean): { messages: Wire }
		}
	).buildRequestBody({ model: 'anthropic/claude-haiku-5.5', messages, ...extra }, true).messages
}

const call = (id: string, name: string) => ({
	id,
	type: 'function' as const,
	function: { name, arguments: '{}' },
})
const img = (data: string) => ({ type: 'image' as const, data, mediaType: 'image/png' })

afterEach(() => vi.unstubAllGlobals())

describe('tool result images', () => {
	it('declares that it carries them', () => {
		expect(OPENROUTER_CAPABILITIES.supportsToolResultImages).toBe(true)
	})

	it('sends one tool image as text in the tool message and the image in a user message after it', () => {
		const wire = build([
			{ role: 'user', content: 'read it' },
			{ role: 'assistant', content: '', toolCalls: [call('c1', 'read_file')] },
			{
				role: 'tool',
				toolCallId: 'c1',
				content: [{ type: 'text', text: 'receipt.png' }, img('QUJD')],
			},
		])
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
		expect(wire[2]).toEqual({
			role: 'tool',
			tool_call_id: 'c1',
			content: 'receipt.png\n[image attached in the next message]',
		})
		expect(wire[3]?.content).toEqual([
			{ type: 'text', text: 'Image returned by the `read_file` tool call c1:' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
		])
		expect(JSON.stringify(wire[2])).not.toContain('QUJD')
	})

	it('puts the images of two tools after BOTH tool messages', () => {
		const wire = build([
			{ role: 'user', content: 'go' },
			{
				role: 'assistant',
				content: '',
				toolCalls: [call('a', 'screenshot'), call('b', 'read_file')],
			},
			{ role: 'tool', toolCallId: 'a', content: [img('AAAA')] },
			{ role: 'tool', toolCallId: 'b', content: [img('BBBB')] },
		])
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
		const parts = wire[4]?.content as Array<{ type: string; text?: string }>
		expect(parts.map((p) => p.type)).toEqual(['text', 'image_url', 'text', 'image_url'])
		expect(parts[0]?.text).toContain('`screenshot`')
		expect(parts[2]?.text).toContain('`read_file`')
	})

	it('keeps a text-only result untouched and sends no extra message', () => {
		const wire = build([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [call('a', 'bash')] },
			{ role: 'tool', toolCallId: 'a', content: 'ok' },
		])
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
		expect(wire[2]?.content).toBe('ok')
	})

	it('keeps the omission note for a model the listing says is text-only', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					data: [
						{
							id: 'a/text',
							name: 't',
							context_length: 1000,
							architecture: { input_modalities: ['text'] },
						},
					],
				}),
			}),
		)
		const provider = new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' })
		await provider.listModels()
		const wire = build(
			[
				{ role: 'user', content: 'go' },
				{ role: 'assistant', content: '', toolCalls: [call('a', 'read_file')] },
				{ role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'x' }, img('QUJD')] },
			],
			{ model: 'a/text' },
			provider,
		)
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
		expect(String(wire[2]?.content)).toContain('[image omitted')
		expect(JSON.stringify(wire)).not.toContain('QUJD')
	})

	it('re-sends an old tool image with its turn, as a pasted image in history is', () => {
		const wire = build([
			{ role: 'user', content: 'first' },
			{ role: 'assistant', content: '', toolCalls: [call('a', 'screenshot')] },
			{ role: 'tool', toolCallId: 'a', content: [img('OLD0')] },
			{ role: 'assistant', content: 'seen' },
			{ role: 'user', content: 'again' },
			{ role: 'assistant', content: '', toolCalls: [call('b', 'screenshot')] },
			{ role: 'tool', toolCallId: 'b', content: [img('NEW0')] },
		])
		expect(wire.map((m) => m.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'user',
			'assistant',
			'user',
			'assistant',
			'tool',
			'user',
		])
		expect(JSON.stringify(wire)).toContain('OLD0')
		expect(JSON.stringify(wire)).toContain('NEW0')
	})

	it('leaves out an image the runtime withheld', () => {
		const wire = build([
			{ role: 'user', content: 'go' },
			{ role: 'assistant', content: '', toolCalls: [call('a', 'screenshot')] },
			{
				role: 'tool',
				toolCallId: 'a',
				content: [{ ...img('QUJD'), modelOmission: { reason: 'provider-rejected' } } as never],
			},
		])
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
		expect(JSON.stringify(wire)).not.toContain('QUJD')
	})

	it('puts the cache breakpoint on the right message when a tool image message is added', () => {
		const wire = build(
			[
				{ role: 'system', content: 'sys', cacheHint: 'cache' },
				{ role: 'user', content: 'go' },
				{ role: 'assistant', content: '', toolCalls: [call('a', 'screenshot')] },
				{ role: 'tool', toolCallId: 'a', content: [img('QUJD')] },
			],
			{ cacheControl: { type: 'ephemeral' } } as never,
		)
		expect(JSON.stringify(wire[0])).toContain('cache_control')
	})
})
