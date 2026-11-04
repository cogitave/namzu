import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { DeepSeekProvider, toDeepSeekMessages } from '../client.js'

const ROUTE = { providerId: 'deepseek', model: 'deepseek-v4-flash', chainIndex: 0 } as const

const webFetch = (id: string) => ({
	id,
	type: 'function' as const,
	function: { name: 'web_fetch', arguments: '{"url":"https://example.test"}' },
})

/** The refusal sentence the runtime gives a call a permission rule denied. */
const NOT_ALLOWED = 'web_fetch is not allowed in this session.'

/**
 * A request is valid for this endpoint when no assistant entry is empty and
 * every tool entry answers a call made by the assistant entry before it.
 */
function expectWellFormed(wire: ReturnType<typeof toDeepSeekMessages>): void {
	let open = new Set<string>()
	for (const message of wire) {
		if (message.role === 'assistant') {
			const calls = (message as { tool_calls?: { id: string }[] }).tool_calls ?? []
			const content = message.content
			expect(Boolean(content) || calls.length > 0).toBe(true)
			open = new Set(calls.map((call) => call.id))
			continue
		}
		if (message.role === 'tool') {
			expect(open.has(message.tool_call_id)).toBe(true)
			continue
		}
		open = new Set()
	}
}

describe('empty assistant history on the DeepSeek wire', () => {
	it.each([null, ''])('omits an assistant with content %j and no tool calls', (content) => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'before' },
			{ role: 'assistant', content },
			{ role: 'assistant', content, toolCalls: [] },
			{ role: 'user', content: 'continue' },
		]
		expect(toDeepSeekMessages(messages, ROUTE)).toEqual([messages[0], messages[3]])
		// Outbound only: the stored history is not rewritten.
		expect(messages).toHaveLength(4)
	})

	it('omits a reasoning-only turn, including its own replayable reasoning', () => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'work' },
			{
				role: 'assistant',
				content: null,
				reasoning: [{ type: 'thinking', text: 'thinking it over' }],
				source: {
					type: 'model',
					...ROUTE,
					replayState: {
						kind: 'namzu-deepseek-reasoning',
						version: 1,
						route: ROUTE,
						reasoningContent: 'thinking it over',
					},
				},
			},
			{ role: 'user', content: 'go on' },
		]
		const wire = toDeepSeekMessages(messages, ROUTE)
		expect(wire).toEqual([messages[0], messages[2]])
		expect(messages[1]).toMatchObject({ reasoning: [{ text: 'thinking it over' }] })
	})

	it('keeps a denied call, its refusal and the reasoning that must come back with it', () => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'look it up' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [webFetch('call-1')],
				reasoning: [{ type: 'thinking', text: 'I will fetch it' }],
				source: {
					type: 'model',
					...ROUTE,
					replayState: {
						kind: 'namzu-deepseek-reasoning',
						version: 1,
						route: ROUTE,
						reasoningContent: 'I will fetch it',
					},
				},
			},
			{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
			{ role: 'assistant', content: null },
			{ role: 'user', content: '[SYSTEM] Turn is ending.' },
		]
		const wire = toDeepSeekMessages(messages, ROUTE)
		expect(wire).toHaveLength(4)
		expect(wire[1]).toMatchObject({
			role: 'assistant',
			content: null,
			reasoning_content: 'I will fetch it',
			tool_calls: [{ id: 'call-1' }],
		})
		expect(wire[2]).toEqual({ role: 'tool', content: NOT_ALLOWED, tool_call_id: 'call-1' })
		expectWellFormed(wire)
	})

	it('keeps two parallel denied calls and both refusals', () => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'look it up' },
			{ role: 'assistant', content: '', toolCalls: [webFetch('call-1'), webFetch('call-2')] },
			{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
			{ role: 'tool', toolCallId: 'call-2', content: NOT_ALLOWED, isError: true },
			{ role: 'assistant', content: null },
		]
		const wire = toDeepSeekMessages(messages, ROUTE)
		expect(wire.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool'])
		expectWellFormed(wire)
	})

	it('sends no empty assistant message in the request after a denied call and an empty reply', async () => {
		const provider = new DeepSeekProvider({ apiKey: 'sk-test' })
		let body: { messages: Parameters<typeof expectWellFormed>[0] } | undefined
		;(provider as unknown as { client: unknown }).client = {
			chat: {
				completions: {
					create: async (request: typeof body) => {
						body = request
						return (async function* () {
							yield {
								id: 'c1',
								choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
							}
						})()
					},
				},
			},
		}
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'look it up' },
			{ role: 'assistant', content: null, toolCalls: [webFetch('call-1')] },
			{ role: 'tool', toolCallId: 'call-1', content: NOT_ALLOWED, isError: true },
			{ role: 'assistant', content: null },
			{ role: 'user', content: '[SYSTEM] Turn is ending.' },
		]
		for await (const _ of provider.chatStream({ model: 'deepseek-v4-flash', messages })) {
			// drain
		}
		expect(body?.messages.map((message) => message.role)).toEqual([
			'user',
			'assistant',
			'tool',
			'user',
		])
		expectWellFormed(body?.messages ?? [])
	})
})
