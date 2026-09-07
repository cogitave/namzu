import { type Message, collectChatCompletion, isProviderRequestError } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenProvider } from '../client.js'
import type { ZenProtocol, ZenService } from '../models.js'

const apiKey = 'opencode-wire-test-secret'
const sessionId = 'namzu-wire-conversation'
const toolInput = '{"city":"Istanbul"}'
const tools = [
	{
		type: 'function' as const,
		function: {
			name: 'weather',
			description: 'Read the weather',
			parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
		},
	},
]

interface WireCase {
	protocol: ZenProtocol
	service: ZenService
	model: string
	path: string
	authHeader: string
	replayMarker: string
}

const cases: WireCase[] = [
	{
		protocol: 'chat',
		service: 'zen',
		model: 'glm-5.3-flash',
		path: '/chat/completions',
		authHeader: 'authorization',
		replayMarker: 'Check the weather.',
	},
	{
		protocol: 'responses',
		service: 'zen',
		model: 'gpt-5.6-luna',
		path: '/responses',
		authHeader: 'authorization',
		replayMarker: 'encrypted-reasoning-fixture',
	},
	{
		protocol: 'messages',
		service: 'zen',
		model: 'claude-haiku-4-5',
		path: '/messages',
		authHeader: 'x-api-key',
		replayMarker: 'anthropic-signature-fixture',
	},
	{
		protocol: 'messages',
		service: 'go',
		model: 'minimax-m3',
		path: '/messages',
		authHeader: 'x-api-key',
		replayMarker: 'anthropic-signature-fixture',
	},
	{
		protocol: 'google',
		service: 'zen',
		model: 'gemini-3.8-flash',
		path: '/models/gemini-3.8-flash:streamGenerateContent?alt=sse',
		authHeader: 'x-goog-api-key',
		replayMarker: 'google-signature-fixture',
	},
]

function sse(frames: readonly unknown[]): string {
	return frames
		.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
		.join('')
}

function frames(protocol: ZenProtocol, model: string, toolRound: boolean): unknown[] {
	const text = toolRound ? 'Looking up the weather.' : 'It is sunny.'
	if (protocol === 'chat') {
		return [
			{
				id: 'completion-1',
				choices: [
					{
						index: 0,
						delta: {
							role: 'assistant',
							...(toolRound && { reasoning_content: 'Check the weather.' }),
						},
					},
				],
			},
			{ id: 'completion-1', choices: [{ index: 0, delta: { content: text } }] },
			...(toolRound
				? [
						{
							id: 'completion-1',
							choices: [
								{
									index: 0,
									delta: {
										tool_calls: [
											{
												index: 0,
												id: 'call-1',
												type: 'function',
												function: { name: 'weather', arguments: '{"city":' },
											},
										],
									},
								},
							],
						},
						{
							id: 'completion-1',
							choices: [
								{
									index: 0,
									delta: { tool_calls: [{ index: 0, function: { arguments: '"Istanbul"}' } }] },
								},
							],
						},
					]
				: []),
			{
				id: 'completion-1',
				choices: [{ index: 0, delta: {}, finish_reason: toolRound ? 'tool_calls' : 'stop' }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 2 },
				},
			},
			'[DONE]',
		]
	}
	if (protocol === 'responses') {
		return [
			{ type: 'response.created', response: { id: 'response-1', created_at: 1, model } },
			...(toolRound
				? [
						{
							type: 'response.output_item.added',
							output_index: 0,
							item: { type: 'reasoning', id: 'reasoning-1' },
						},
						{
							type: 'response.reasoning_summary_part.added',
							item_id: 'reasoning-1',
							summary_index: 0,
						},
						{
							type: 'response.reasoning_summary_text.delta',
							item_id: 'reasoning-1',
							summary_index: 0,
							delta: 'Check the weather.',
						},
						{
							type: 'response.reasoning_summary_part.done',
							item_id: 'reasoning-1',
							summary_index: 0,
						},
						{
							type: 'response.output_item.done',
							output_index: 0,
							item: {
								type: 'reasoning',
								id: 'reasoning-1',
								encrypted_content: 'encrypted-reasoning-fixture',
							},
						},
					]
				: []),
			{
				type: 'response.output_item.added',
				output_index: 1,
				item: { type: 'message', id: 'message-1' },
			},
			{ type: 'response.output_text.delta', item_id: 'message-1', delta: text },
			{
				type: 'response.output_item.done',
				output_index: 1,
				item: { type: 'message', id: 'message-1' },
			},
			...(toolRound
				? [
						{
							type: 'response.output_item.added',
							output_index: 2,
							item: {
								type: 'function_call',
								id: 'function-1',
								call_id: 'call-1',
								name: 'weather',
								arguments: '',
							},
						},
						{
							type: 'response.function_call_arguments.delta',
							item_id: 'function-1',
							output_index: 2,
							delta: toolInput,
						},
						{
							type: 'response.output_item.done',
							output_index: 2,
							item: {
								type: 'function_call',
								id: 'function-1',
								call_id: 'call-1',
								name: 'weather',
								arguments: toolInput,
								status: 'completed',
							},
						},
					]
				: []),
			{
				type: 'response.completed',
				response: {
					usage: {
						input_tokens: 10,
						output_tokens: 5,
						total_tokens: 15,
						input_tokens_details: { cached_tokens: 2 },
					},
				},
			},
		]
	}
	if (protocol === 'messages') {
		return [
			{
				type: 'message_start',
				message: {
					id: 'message-1',
					type: 'message',
					role: 'assistant',
					model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 8,
						output_tokens: 0,
						cache_read_input_tokens: 2,
						cache_creation_input_tokens: 0,
					},
				},
			},
			...(toolRound
				? [
						{
							type: 'content_block_start',
							index: 0,
							content_block: { type: 'thinking', thinking: '' },
						},
						{
							type: 'content_block_delta',
							index: 0,
							delta: { type: 'thinking_delta', thinking: 'Check the weather.' },
						},
						{
							type: 'content_block_delta',
							index: 0,
							delta: { type: 'signature_delta', signature: 'anthropic-signature-fixture' },
						},
						{ type: 'content_block_stop', index: 0 },
					]
				: []),
			{ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
			{ type: 'content_block_stop', index: 1 },
			...(toolRound
				? [
						{
							type: 'content_block_start',
							index: 2,
							content_block: { type: 'tool_use', id: 'call-1', name: 'weather', input: {} },
						},
						{
							type: 'content_block_delta',
							index: 2,
							delta: { type: 'input_json_delta', partial_json: toolInput },
						},
						{ type: 'content_block_stop', index: 2 },
					]
				: []),
			{
				type: 'message_delta',
				delta: { stop_reason: toolRound ? 'tool_use' : 'end_turn', stop_sequence: null },
				usage: { output_tokens: 5 },
			},
			{ type: 'message_stop' },
		]
	}
	return [
		{
			candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] } }],
			modelVersion: model,
			responseId: 'response-1',
		},
		...(toolRound
			? [
					{
						candidates: [
							{
								index: 0,
								content: {
									role: 'model',
									parts: [
										{
											functionCall: { name: 'weather', args: { city: 'Istanbul' } },
											thoughtSignature: 'google-signature-fixture',
										},
									],
								},
							},
						],
					},
				]
			: []),
		{
			candidates: [{ index: 0, finishReason: 'STOP' }],
			usageMetadata: {
				promptTokenCount: 10,
				candidatesTokenCount: 5,
				totalTokenCount: 15,
				cachedContentTokenCount: 2,
			},
		},
	]
}

interface RecordedRequest {
	url: string
	headers: Headers
	body: Record<string, unknown>
	signal: AbortSignal | null | undefined
}

function recordRequest(input: string | URL | Request, init?: RequestInit): RecordedRequest {
	return {
		url: String(input),
		headers: new Headers(init?.headers),
		body: JSON.parse(String(init?.body)),
		signal: init?.signal,
	}
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('Zen real protocol clients over HTTP fixtures', () => {
	it.each(cases)(
		'$service $protocol streams a tool round, persists native replay, and sends the result',
		async (fixture) => {
			const requests: RecordedRequest[] = []
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					requests.push(recordRequest(input, init))
					return new Response(sse(frames(fixture.protocol, fixture.model, requests.length === 1)), {
						headers: { 'content-type': 'text/event-stream' },
					})
				}),
			)
			const provider = new ZenProvider({ apiKey, sessionId }, fixture.service)
			const messages: Message[] = [{ role: 'user', content: 'What is the weather in Istanbul?' }]
			const first = await collectChatCompletion(
				provider.chatStream({
					model: fixture.model,
					messages,
					tools,
					maxTokens: 256,
					...(fixture.protocol === 'chat' && { effort: 'high' as const }),
				}),
			)
			expect(first.message.content).toBe('Looking up the weather.')
			expect(first.finishReason).toBe('tool_calls')
			expect(first.message.toolCalls).toHaveLength(1)
			expect(first.message.toolCalls?.[0]?.function).toEqual({
				name: 'weather',
				arguments: toolInput,
			})
			expect(first.usage).toMatchObject({
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				cachedTokens: 2,
			})
			expect(first.message.replayState).toBeDefined()
			const toolCallId = first.message.toolCalls?.[0]?.id
			if (!toolCallId) throw new Error('Expected tool call ID')
			const { replayState, ...assistant } = first.message
			messages.push({
				...assistant,
				source: {
					type: 'model',
					providerId: provider.id,
					model: fixture.model,
					chainIndex: 0,
					replayState,
				},
			})
			messages.push({ role: 'tool', toolCallId, content: 'Sunny, 23 degrees Celsius.' })
			// Persistence must not depend on object identity or an in-memory provider cache.
			const restoredMessages: Message[] = JSON.parse(JSON.stringify(messages))
			const restoredProvider = new ZenProvider({ apiKey, sessionId }, fixture.service)
			const second = await collectChatCompletion(
				restoredProvider.chatStream({
					model: fixture.model,
					messages: restoredMessages,
					tools,
					maxTokens: 256,
				}),
			)
			expect(second.message.content).toBe('It is sunny.')
			expect(second.finishReason).toBe('stop')
			expect(requests).toHaveLength(2)
			for (const request of requests) {
				const base =
					fixture.service === 'go' ? 'https://opencode.ai/zen/go/v1' : 'https://opencode.ai/zen/v1'
				expect(request.url).toBe(base + fixture.path)
				expect(request.headers.get(fixture.authHeader)).toBe(
					fixture.authHeader === 'authorization' ? `Bearer ${apiKey}` : apiKey,
				)
				expect(request.headers.get('x-opencode-session')).toBe(sessionId)
				expect(request.headers.get('user-agent')).toMatch(/^namzu\//)
			}
			const secondBody = requests[1]?.body
			expect(JSON.stringify(secondBody)).toContain('Sunny, 23 degrees Celsius.')
			expect(JSON.stringify(secondBody)).toContain(fixture.replayMarker)
			expect(JSON.stringify(secondBody)).not.toContain('skip_thought_signature_validator')
			if (fixture.protocol === 'chat') {
				expect(requests[0]?.body.reasoning_effort).toBe('high')
				expect(secondBody).toMatchObject({
					messages: expect.arrayContaining([
						{ role: 'tool', tool_call_id: toolCallId, content: 'Sunny, 23 degrees Celsius.' },
					]),
				})
			} else if (fixture.protocol === 'responses') {
				expect(secondBody).toMatchObject({
					input: expect.arrayContaining([
						{
							type: 'function_call_output',
							call_id: toolCallId,
							output: 'Sunny, 23 degrees Celsius.',
						},
					]),
				})
			} else if (fixture.protocol === 'messages') {
				expect(requests[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
				expect(secondBody).toMatchObject({
					messages: expect.arrayContaining([
						{
							role: 'user',
							content: expect.arrayContaining([
								{
									type: 'tool_result',
									tool_use_id: toolCallId,
									content: 'Sunny, 23 degrees Celsius.',
								},
							]),
						},
					]),
				})
			} else {
				expect(JSON.stringify(secondBody)).toContain('functionResponse')
			}
		},
	)

	it.each(cases)(
		'$service $protocol classifies HTTP 429 without retaining credentials or response text',
		async (fixture) => {
			vi.stubGlobal(
				'fetch',
				vi.fn(
					async () =>
						new Response(
							JSON.stringify({
								error: { message: `Rate limit for ${apiKey}`, type: 'rate_limit_error' },
							}),
							{ status: 429, headers: { 'content-type': 'application/json', 'retry-after': '3' } },
						),
				),
			)
			const provider = new ZenProvider({ apiKey, sessionId }, fixture.service)
			let caught: unknown
			try {
				await collectChatCompletion(
					provider.chatStream({
						model: fixture.model,
						messages: [{ role: 'user', content: 'Hello' }],
						maxTokens: 100,
					}),
				)
			} catch (error) {
				caught = error
			}
			expect(isProviderRequestError(caught)).toBe(true)
			expect(caught).toMatchObject({ kind: 'throttle', providerId: provider.id, status: 429 })
			expect(String(caught)).not.toContain(apiKey)
			expect(JSON.stringify(caught)).not.toContain(apiKey)
			expect(caught).not.toHaveProperty('cause')
		},
	)

	it.each(cases)(
		'$service $protocol forwards cancellation into the active response body',
		async (fixture) => {
			let requestSignal: AbortSignal | null | undefined
			const interrupted = vi.fn()
			vi.stubGlobal(
				'fetch',
				vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
					requestSignal = init?.signal
					const allFrames = frames(fixture.protocol, fixture.model, false)
					const firstFrames = allFrames.slice(
						0,
						fixture.protocol === 'chat'
							? 2
							: fixture.protocol === 'responses'
								? 3
								: fixture.protocol === 'messages'
									? 3
									: 1,
					)
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode(sse(firstFrames)))
							requestSignal?.addEventListener(
								'abort',
								() => {
									interrupted()
									controller.error(requestSignal?.reason)
								},
								{ once: true },
							)
						},
					})
					return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
				}),
			)
			const controller = new AbortController()
			const provider = new ZenProvider({ apiKey, sessionId }, fixture.service)
			const iterator = provider
				.chatStream({
					model: fixture.model,
					messages: [{ role: 'user', content: 'Hello' }],
					maxTokens: 100,
					signal: controller.signal,
				})
				[Symbol.asyncIterator]()
			const first = await iterator.next()
			expect(first.value?.delta.content).toBe('It is sunny.')
			const reason = new Error('Operator stopped the run')
			controller.abort(reason)
			await expect(iterator.next()).rejects.toBe(reason)
			expect(requestSignal?.aborted).toBe(true)
			expect(interrupted).toHaveBeenCalledTimes(1)
		},
	)
})
