import type { ChatCompletionParams } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'
import type { HttpDialect } from '../types.js'
import { finishedStream } from './finished-stream.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const call = (id: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'web_fetch', arguments: '{"url":"https://example.test"}' },
})
const NOT_ALLOWED = 'web_fetch is not allowed in this session.'

/** The history after a denied call whose next reply came back empty. */
const HISTORY: ChatCompletionParams['messages'] = [
	{ role: 'user', content: 'look it up' },
	{ role: 'assistant', content: null, toolCalls: [call('call-1'), call('call-2')] },
	{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
	{ role: 'tool', toolCallId: 'call-2', content: NOT_ALLOWED, isError: true },
	{ role: 'assistant', content: null },
	{ role: 'assistant', content: '', toolCalls: [] },
	{ role: 'user', content: '[SYSTEM] Turn is ending.' },
]

type WireMessage = {
	role: string
	content?: unknown
	tool_calls?: unknown[]
	tool_call_id?: string
}

async function wireFor(
	dialect: HttpDialect,
	messages: ChatCompletionParams['messages'],
): Promise<WireMessage[]> {
	let captured: { messages: WireMessage[] } = { messages: [] }
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			captured = JSON.parse(String(init.body))
			return new Response(finishedStream(dialect), {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		}),
	)
	const provider = new HttpProvider({ baseURL: 'https://example.test/v1', apiKey: 'k', dialect })
	for await (const _chunk of provider.chatStream({ model: 'm', messages })) {
		// drain
	}
	return captured.messages
}

const emptyContent = (content: unknown): boolean =>
	content === null ||
	content === undefined ||
	content === '' ||
	(Array.isArray(content) && content.length === 0)

describe('empty assistant history on the openai dialect', () => {
	it('sends no empty assistant entry and keeps every tool result after its call', async () => {
		const wire = await wireFor('openai', HISTORY)
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user'])
		for (const m of wire.filter((entry) => entry.role === 'assistant')) {
			expect(emptyContent(m.content) && !m.tool_calls?.length).toBe(false)
		}
		expect(wire[1]?.tool_calls).toHaveLength(2)
		expect(wire.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual([
			'call-1',
			'call-2',
		])
	})

	it('does not send an empty tool_calls array beside real text', async () => {
		const wire = await wireFor('openai', [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'hello', toolCalls: [] },
			{ role: 'user', content: 'again' },
		])
		expect(wire[1]).toEqual({ role: 'assistant', content: 'hello' })
	})
})

describe('empty assistant history on the anthropic dialect', () => {
	it('sends no empty assistant entry and keeps every tool result after its call', async () => {
		const wire = await wireFor('anthropic', HISTORY)
		expect(wire.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
		for (const m of wire.filter((entry) => entry.role === 'assistant')) {
			expect(emptyContent(m.content)).toBe(false)
		}
		const results = (wire[2]?.content as { type: string; tool_use_id: string }[]).map(
			(block) => block.tool_use_id,
		)
		expect(results).toEqual(['call-1', 'call-2'])
		// The literal text "null" is what an empty reply used to become.
		expect(JSON.stringify(wire)).not.toContain('"null"')
	})
})
