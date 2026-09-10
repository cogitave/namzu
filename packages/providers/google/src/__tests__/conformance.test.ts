import { collectChatCompletion } from '@namzu/sdk'
import { defineProviderDriverConformance } from '@namzu/sdk/testing'
import { describe, expect, it, vi } from 'vitest'
import { GoogleProvider } from '../client.js'

for (const oauth of [false, true]) {
	defineProviderDriverConformance({
		describe,
		it,
		expect,
		label: oauth ? 'Gemini Code Assist' : 'Gemini API',
		registryType: 'google',
		retryDefaults: undefined,
		attribution: { kind: 'header' },
		makeProvider: () =>
			new GoogleProvider(
				oauth
					? { getAccessToken: async () => 'fixture-token', projectId: 'fixture-project' }
					: { apiKey: 'fixture-key' },
			),
	})
}

it('attributes both native routes and streams complete tool calls through the SDK collector', async () => {
	for (const oauth of [false, true]) {
		const native = {
			candidates: [
				{
					content: {
						parts: [
							{
								functionCall: { name: 'lookup', args: { name: 'Namzu' } },
								thoughtSignature: 'signed',
							},
						],
					},
					finishReason: 'STOP',
				},
			],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
		}
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(
				new Response(`data: ${JSON.stringify(oauth ? { response: native } : native)}\n\n`),
			)
		const provider = new GoogleProvider(
			oauth
				? { getAccessToken: async () => 'fixture-token', projectId: 'fixture-project', fetch }
				: { apiKey: 'fixture-key', fetch },
		)
		const result = await collectChatCompletion(
			provider.chatStream({
				model: 'gemini-2.5-flash',
				messages: [{ role: 'user', content: 'Lookup Namzu' }],
				tools: [
					{
						type: 'function',
						function: {
							name: 'lookup',
							description: 'Lookup a name',
							parameters: { type: 'object', properties: { name: { type: 'string' } } },
						},
					},
				],
			}),
		)
		expect(result.finishReason).toBe('tool_calls')
		expect(result.message.toolCalls?.[0]?.function).toEqual({
			name: 'lookup',
			arguments: '{"name":"Namzu"}',
		})
		expect(result.usage.totalTokens).toBe(13)
		const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers)
		expect(headers.get('user-agent')).toMatch(/^namzu\//)
		expect(headers.get(oauth ? 'authorization' : 'x-goog-api-key')).toBe(
			oauth ? 'Bearer fixture-token' : 'fixture-key',
		)
		expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error')
	}
})
