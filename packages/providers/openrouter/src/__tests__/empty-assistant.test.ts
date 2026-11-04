import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { OpenRouterProvider } from '../client.js'

type WireMessage = {
	role: string
	content?: unknown
	tool_calls?: unknown[]
	tool_call_id?: string
}

function wireFor(messages: ChatCompletionParams['messages']): WireMessage[] {
	const provider = new OpenRouterProvider({ apiKey: 'k' })
	return (
		provider as unknown as {
			buildRequestBody(p: ChatCompletionParams, stream: boolean): { messages: WireMessage[] }
		}
	).buildRequestBody({ model: 'deepseek/deepseek-v4-flash', messages }, true).messages
}

const call = (id: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'web_fetch', arguments: '{"url":"https://example.test"}' },
})
const NOT_ALLOWED = 'web_fetch is not allowed in this session.'

describe('empty assistant history on the OpenRouter wire', () => {
	it('sends no empty assistant entry and keeps every tool result after its call', () => {
		const wire = wireFor([
			{ role: 'user', content: 'look it up' },
			{ role: 'assistant', content: null, toolCalls: [call('call-1'), call('call-2')] },
			{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
			{ role: 'tool', toolCallId: 'call-2', content: NOT_ALLOWED, isError: true },
			{ role: 'assistant', content: null },
			{ role: 'assistant', content: '', toolCalls: [] },
			{ role: 'user', content: '[SYSTEM] Turn is ending.' },
		])
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
		expect(wire[1]?.tool_calls).toHaveLength(2)
		expect(wire.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual([
			'call-1',
			'call-2',
		])
	})

	it('does not send an empty tool_calls array beside real text', () => {
		const wire = wireFor([
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello', toolCalls: [] },
			{ role: 'user', content: 'again' },
		])
		expect(wire[1]).toEqual({ role: 'assistant', content: 'hello' })
	})
})
