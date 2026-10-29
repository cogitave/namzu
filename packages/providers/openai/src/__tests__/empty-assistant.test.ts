import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { OpenAIProvider, toOpenAIMessages } from '../client.js'

describe('empty assistant history on the Chat Completions wire', () => {
	it.each([null, ''])('omits an assistant with content %j and no tool calls', (content) => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'before' },
			{ role: 'assistant', content },
			{ role: 'assistant', content, toolCalls: [] },
			{ role: 'user', content: 'continue' },
		]
		expect(toOpenAIMessages(messages)).toEqual([messages[0], messages[3]])
		// Normalization is outbound only: the durable history is not rewritten.
		expect(messages).toHaveLength(4)
	})

	it('keeps tool calls and their results even when assistant text is empty', () => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'user', content: 'inspect' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'call-1',
						type: 'function',
						function: { name: 'read', arguments: '{}' },
					},
				],
			},
			{ role: 'tool', content: '', toolCallId: 'call-1' },
			{ role: 'assistant', content: 'done' },
		]
		expect(toOpenAIMessages(messages)).toEqual([
			{ role: 'user', content: 'inspect' },
			{
				role: 'assistant',
				content: null,
				tool_calls: [
					{
						id: 'call-1',
						type: 'function',
						function: { name: 'read', arguments: '{}' },
					},
				],
			},
			{ role: 'tool', content: '', tool_call_id: 'call-1' },
			{ role: 'assistant', content: 'done' },
		])
	})

	it('does not send a reasoning-only foreign turn as an empty assistant or mutate its reasoning', () => {
		const reasoning = [
			{
				type: 'thinking' as const,
				text: 'foreign private reasoning',
				signature: 'sig',
			},
		]
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'assistant', content: '', reasoning },
			{ role: 'user', content: 'continue' },
		]
		expect(toOpenAIMessages(messages)).toEqual([{ role: 'user', content: 'continue' }])
		expect(messages[0]).toEqual({ role: 'assistant', content: '', reasoning })
	})

	it('filters the invalid messages[145] before the streaming request reaches transport', async () => {
		const provider = new OpenAIProvider({
			apiKey: 'test-key',
			baseURL: 'https://example.invalid/v1',
		})
		let body: Record<string, unknown> | undefined
		;(provider as unknown as { client: unknown }).client = {
			chat: {
				completions: {
					create: async (request: Record<string, unknown>) => {
						body = request
						return (async function* () {
							yield {
								choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
							}
						})()
					},
				},
			},
		}
		const messages: ChatCompletionParams['messages'] = Array.from({ length: 145 }, (_, i) =>
			i % 2 === 0
				? { role: 'user' as const, content: 'question' }
				: { role: 'assistant' as const, content: 'answer' },
		)
		messages.push({ role: 'assistant', content: null }, { role: 'user', content: 'continue' })
		const output: string[] = []
		for await (const chunk of provider.chatStream({
			model: 'compatible-model',
			messages,
		})) {
			if (chunk.delta.content) output.push(chunk.delta.content)
		}
		expect(body?.messages).toEqual([...messages.slice(0, 145), messages[146]])
		expect(output).toEqual(['ok'])
		expect(messages).toHaveLength(147)
	})
})
