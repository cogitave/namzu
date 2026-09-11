import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../client.js'

const blocks = [
	{ type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} },
	{
		type: 'web_search_tool_result',
		tool_use_id: 'search-1',
		content: [
			{
				type: 'web_search_result',
				url: 'https://example.com',
				title: 'Source',
				encrypted_content: 'opaque-result',
			},
		],
	},
	{ type: 'text', text: '' },
]
const citation = {
	type: 'web_search_result_location',
	url: 'https://example.com',
	title: 'Source',
	cited_text: 'Found',
	encrypted_index: 'opaque-citation',
}
function fixture() {
	const events = [
		{ type: 'message_start', message: { id: 'm' } },
		...blocks.flatMap((b, index) => [
			{ type: 'content_block_start', index, content_block: b },
			...(index === 0
				? [
						{
							type: 'content_block_delta',
							index,
							delta: {
								type: 'input_json_delta',
								partial_json: '{"query":"test"}',
							},
						},
					]
				: []),
			...(index === 2
				? [
						{
							type: 'content_block_delta',
							index,
							delta: { type: 'text_delta', text: 'Found.' },
						},
						{
							type: 'content_block_delta',
							index,
							delta: { type: 'citations_delta', citation },
						},
					]
				: []),
			{ type: 'content_block_stop', index },
		]),
		{ type: 'message_delta', delta: { stop_reason: 'end_turn' } },
		{ type: 'message_stop' },
	]
	const create = vi.fn(async () =>
		(async function* () {
			for (const event of events) yield event
		})(),
	)
	const provider = new AnthropicProvider({ apiKey: 'fixture' })
	;(provider as unknown as { client: unknown }).client = {
		messages: { create },
	}
	return { provider, create }
}
async function collect(provider: AnthropicProvider, params: ChatCompletionParams) {
	const chunks: StreamChunk[] = []
	for await (const c of provider.chatStream(params)) chunks.push(c)
	return chunks
}
const request: ChatCompletionParams = {
	model: 'claude-sonnet-5',
	messages: [{ role: 'user', content: 'Search' }],
	webSearch: { mode: 'live' },
}
it('uses hosted search, emits activity without local calls, and preserves encrypted continuation', async () => {
	const { provider, create } = fixture()
	const chunks = await collect(provider, request)
	expect((create.mock.calls[0] as unknown as [Record<string, unknown>])[0].tools).toContainEqual({
		type: 'web_search_20250305',
		name: 'web_search',
	})
	expect(chunks.flatMap((c) => c.delta.toolCalls ?? [])).toEqual([])
	expect(chunks.flatMap((c) => (c.delta.hostedTool ? [c.delta.hostedTool.status] : []))).toEqual([
		'running',
		'completed',
	])
	const text = chunks.map((c) => c.delta.content ?? '').join('')
	expect(text).toContain('https://example.com')
	const replayState = chunks.find((c) => c.replayState)?.replayState
	const assistant = {
		role: 'assistant' as const,
		content: text,
		source: {
			type: 'model' as const,
			providerId: 'anthropic',
			model: request.model,
			chainIndex: 0,
			replayState,
		},
	}
	await collect(provider, {
		...request,
		messages: [...request.messages, assistant, { role: 'user', content: 'Continue' }],
	})
	const body = (create.mock.calls[1] as unknown as [Record<string, unknown>])[0]
	expect(JSON.stringify(body.messages)).toContain('opaque-result')
	expect(JSON.stringify(body.messages)).toContain('opaque-citation')
	expect(JSON.stringify(body.messages)).toContain('"query":"test"')
	await collect(provider, {
		...request,
		messages: [{ ...assistant, content: 'Edited answer' }],
	})
	expect(
		JSON.stringify((create.mock.calls[2] as unknown as [Record<string, unknown>])[0].messages),
	).not.toContain('opaque-result')
	await collect(provider, {
		...request,
		model: 'claude-opus-5',
		messages: [assistant],
	})
	expect(
		JSON.stringify((create.mock.calls[3] as unknown as [Record<string, unknown>])[0].messages),
	).not.toContain('opaque-result')
})
it('refuses cached mode, unknown models and proxy routes before network dispatch', async () => {
	const { provider, create } = fixture()
	expect(provider.supportsHostedWebSearchFor('custom-model', 'live')).toBe(false)
	expect(
		new AnthropicProvider({
			apiKey: 'fixture',
			baseURL: 'https://proxy.example',
		}).supportsHostedWebSearchFor(request.model, 'live'),
	).toBe(false)
	await expect(collect(provider, { ...request, webSearch: { mode: 'cached' } })).rejects.toThrow(
		/native search/,
	)
	expect(create).not.toHaveBeenCalled()
})
