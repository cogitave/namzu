import { DuplicateProviderError, ProviderRegistry, ProviderRequestError } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpProvider } from '../client.js'
import { HTTP_CAPABILITIES, registerHttp } from '../index.js'
import { DialectMismatchError } from '../types.js'

beforeEach(() => {
	if (ProviderRegistry.isSupported('http')) {
		ProviderRegistry.unregister('http')
	}
})

afterEach(() => {
	vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockJsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function mockSseResponse(frames: string[], status = 200): Response {
	// Join with blank lines between frames, and ensure each frame has a trailing \n.
	const text = `${frames.join('\n\n')}\n\n`
	return new Response(text, {
		status,
		headers: { 'Content-Type': 'text/event-stream' },
	})
}

async function collectStream<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const out: T[] = []
	for await (const x of iter) out.push(x)
	return out
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('@namzu/http — registration', () => {
	it("adds 'http' to the ProviderRegistry", () => {
		expect(ProviderRegistry.isSupported('http')).toBe(false)
		registerHttp()
		expect(ProviderRegistry.isSupported('http')).toBe(true)
		expect(ProviderRegistry.listTypes()).toContain('http')
	})

	it('throws DuplicateProviderError when called twice without options', () => {
		registerHttp()
		expect(() => registerHttp()).toThrowError(DuplicateProviderError)
	})

	it('allows re-registration when { replace: true } is passed', () => {
		registerHttp()
		expect(() => registerHttp({ replace: true })).not.toThrow()
		expect(ProviderRegistry.isSupported('http')).toBe(true)
	})

	it('exposes capabilities through the registry after registration', () => {
		registerHttp()
		const caps = ProviderRegistry.getCapabilities('http')
		expect(caps).toEqual(HTTP_CAPABILITIES)
	})

	it('HTTP_CAPABILITIES declares the expected flags', () => {
		expect(HTTP_CAPABILITIES).toEqual({
			supportsTools: true,
			supportsStreaming: true,
			supportsFunctionCalling: true,
			supportsAbortSignal: true,
		})
	})

	it('ProviderRegistry.create({ type: "http", ... }) instantiates HttpProvider', () => {
		registerHttp()
		const { provider, capabilities } = ProviderRegistry.create({
			type: 'http',
			baseURL: 'https://example.com/v1',
			apiKey: 'test',
		})
		expect(provider).toBeInstanceOf(HttpProvider)
		expect(capabilities).toEqual(HTTP_CAPABILITIES)
	})
})

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

describe('@namzu/http — request construction', () => {
	it('openai dialect: POSTs chat/completions with Bearer auth and OpenAI body shape', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockJsonResponse({
				id: 'x',
				model: 'gpt-4o',
				choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const provider = new HttpProvider({
			baseURL: 'https://api.openai.com/v1',
			apiKey: 'sk-test',
			dialect: 'openai',
		})

		await provider.chat({
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'hi' }],
			temperature: 0.5,
			maxTokens: 10,
		})

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const call = fetchMock.mock.calls[0]!
		const url = call[0] as string
		const init = call[1] as { method: string; headers: Record<string, string>; body: string }
		expect(url).toBe('https://api.openai.com/v1/chat/completions')
		expect(init.method).toBe('POST')
		expect(init.headers['Content-Type']).toBe('application/json')
		expect(init.headers.Authorization).toBe('Bearer sk-test')
		const body = JSON.parse(init.body)
		expect(body.model).toBe('gpt-4o')
		expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
		expect(body.temperature).toBe(0.5)
		expect(body.max_tokens).toBe(10)
		expect(body.stream).toBe(false)
	})

	it('anthropic dialect: POSTs /messages with x-api-key + anthropic-version + max_tokens', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockJsonResponse({
				id: 'msg_1',
				type: 'message',
				role: 'assistant',
				model: 'claude-sonnet-4',
				content: [{ type: 'text', text: 'hi' }],
				stop_reason: 'end_turn',
				usage: { input_tokens: 1, output_tokens: 1 },
			}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const provider = new HttpProvider({
			baseURL: 'https://api.anthropic.com/v1',
			apiKey: 'anthropic-key',
			dialect: 'anthropic',
		})

		await provider.chat({
			model: 'claude-sonnet-4',
			messages: [
				{ role: 'system', content: 'You are helpful.' },
				{ role: 'user', content: 'hi' },
			],
		})

		const call = fetchMock.mock.calls[0]!
		const url = call[0] as string
		const init = call[1] as { method: string; headers: Record<string, string>; body: string }
		expect(url).toBe('https://api.anthropic.com/v1/messages')
		expect(init.headers['x-api-key']).toBe('anthropic-key')
		expect(init.headers['anthropic-version']).toBe('2023-06-01')
		// Should not have Authorization Bearer header in anthropic dialect.
		expect(init.headers.Authorization).toBeUndefined()

		const body = JSON.parse(init.body)
		expect(body.model).toBe('claude-sonnet-4')
		// System prompt becomes top-level `system` string, not a message.
		expect(body.system).toBe('You are helpful.')
		expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
		// Anthropic requires max_tokens — provider must default it if absent.
		expect(body.max_tokens).toBeDefined()
		expect(typeof body.max_tokens).toBe('number')
	})

	it('openai dialect: omits Authorization header when no apiKey is configured', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockJsonResponse({
				id: 'x',
				model: 'llama3',
				choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
			}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const provider = new HttpProvider({
			baseURL: 'http://localhost:11434/v1',
			dialect: 'openai',
		})

		await provider.chat({ model: 'llama3', messages: [{ role: 'user', content: 'hi' }] })

		const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }
		expect(init.headers.Authorization).toBeUndefined()
	})

	it('merges custom headers into the request', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			mockJsonResponse({
				id: 'x',
				model: 'm',
				choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
			}),
		)
		vi.stubGlobal('fetch', fetchMock)

		const provider = new HttpProvider({
			baseURL: 'https://example.com/v1',
			dialect: 'openai',
			headers: { 'X-Custom-Tenant': 'team-42' },
		})

		await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> }
		expect(init.headers['X-Custom-Tenant']).toBe('team-42')
	})
})

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

describe('@namzu/http — response parsing', () => {
	it('openai dialect: maps choices + usage + finishReason into ChatCompletionResponse', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockJsonResponse({
					id: 'cmpl-1',
					model: 'gpt-4o',
					choices: [
						{
							message: {
								role: 'assistant',
								content: 'hello world',
								tool_calls: [
									{
										id: 'call_1',
										type: 'function',
										function: { name: 'search', arguments: '{"q":"cats"}' },
									},
								],
							},
							finish_reason: 'tool_calls',
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				}),
			),
		)

		const provider = new HttpProvider({
			baseURL: 'https://api.openai.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})

		const resp = await provider.chat({
			model: 'gpt-4o',
			messages: [{ role: 'user', content: 'hi' }],
		})
		expect(resp.id).toBe('cmpl-1')
		expect(resp.model).toBe('gpt-4o')
		expect(resp.message.content).toBe('hello world')
		expect(resp.message.toolCalls?.[0]).toEqual({
			id: 'call_1',
			type: 'function',
			function: { name: 'search', arguments: '{"q":"cats"}' },
		})
		expect(resp.finishReason).toBe('tool_calls')
		expect(resp.usage.promptTokens).toBe(10)
		expect(resp.usage.completionTokens).toBe(5)
		expect(resp.usage.totalTokens).toBe(15)
	})

	it('anthropic dialect: flattens content array + maps stop_reason → finishReason', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockJsonResponse({
					id: 'msg_1',
					type: 'message',
					role: 'assistant',
					model: 'claude-sonnet-4',
					content: [
						{ type: 'text', text: 'Let me search.' },
						{ type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'cats' } },
					],
					stop_reason: 'tool_use',
					usage: { input_tokens: 8, output_tokens: 4 },
				}),
			),
		)

		const provider = new HttpProvider({
			baseURL: 'https://api.anthropic.com/v1',
			apiKey: 'k',
			dialect: 'anthropic',
		})

		const resp = await provider.chat({
			model: 'claude-sonnet-4',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(resp.message.content).toBe('Let me search.')
		expect(resp.message.toolCalls).toHaveLength(1)
		expect(resp.message.toolCalls?.[0]).toEqual({
			id: 'tu_1',
			type: 'function',
			function: { name: 'search', arguments: '{"q":"cats"}' },
		})
		expect(resp.finishReason).toBe('tool_calls')
		expect(resp.usage.promptTokens).toBe(8)
		expect(resp.usage.completionTokens).toBe(4)
		expect(resp.usage.totalTokens).toBe(12)
	})

	it('anthropic dialect: maps max_tokens stop_reason → length', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockJsonResponse({
					id: 'msg_2',
					type: 'message',
					model: 'claude-sonnet-4',
					content: [{ type: 'text', text: 'truncated...' }],
					stop_reason: 'max_tokens',
					usage: { input_tokens: 1, output_tokens: 10 },
				}),
			),
		)

		const provider = new HttpProvider({
			baseURL: 'https://api.anthropic.com/v1',
			apiKey: 'k',
			dialect: 'anthropic',
		})

		const resp = await provider.chat({
			model: 'claude-sonnet-4',
			messages: [{ role: 'user', content: 'hi' }],
		})
		expect(resp.finishReason).toBe('length')
	})
})

// ---------------------------------------------------------------------------
// DialectMismatchError
// ---------------------------------------------------------------------------

describe('@namzu/http — DialectMismatchError', () => {
	it("throws when dialect='anthropic' but response has OpenAI .choices shape", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockJsonResponse({
					id: 'x',
					model: 'm',
					choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
				}),
			),
		)

		const provider = new HttpProvider({
			baseURL: 'https://example.com/v1',
			apiKey: 'k',
			dialect: 'anthropic',
		})

		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toThrowError(DialectMismatchError)
	})

	it("throws when dialect='openai' but response has Anthropic .content array shape", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				mockJsonResponse({
					id: 'msg_1',
					type: 'message',
					model: 'claude',
					content: [{ type: 'text', text: 'hi' }],
					stop_reason: 'end_turn',
				}),
			),
		)

		const provider = new HttpProvider({
			baseURL: 'https://example.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})

		await expect(
			provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
		).rejects.toThrowError(DialectMismatchError)
	})

	it('DialectMismatchError carries url, status, and sample', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(mockJsonResponse({ unexpected: 'shape' }, 200)),
		)

		const provider = new HttpProvider({
			baseURL: 'https://example.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})

		try {
			await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
			expect.fail('expected throw')
		} catch (err) {
			expect(err).toBeInstanceOf(DialectMismatchError)
			const e = err as DialectMismatchError
			expect(e.dialect).toBe('openai')
			expect(e.url).toBe('https://example.com/v1/chat/completions')
			expect(e.status).toBe(200)
			expect(e.sample).toContain('unexpected')
		}
	})
})

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('@namzu/http — streaming', () => {
	it('openai dialect: parses SSE data frames into StreamChunks and stops on [DONE]', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockSseResponse([
						'data: {"id":"c1","choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}',
						'data: {"id":"c1","choices":[{"delta":{"content":"lo"},"finish_reason":null}]}',
						'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
						'data: [DONE]',
					]),
				),
		)

		const provider = new HttpProvider({
			baseURL: 'https://api.openai.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})

		const chunks = await collectStream(
			provider.chatStream({
				model: 'gpt-4o',
				messages: [{ role: 'user', content: 'hi' }],
			}),
		)

		const text = chunks.map((c) => c.delta.content ?? '').join('')
		expect(text).toBe('Hello')
		const last = chunks[chunks.length - 1]
		expect(last?.finishReason).toBe('stop')
		expect(last?.usage?.totalTokens).toBe(7)
	})

	it('anthropic dialect: parses content_block_delta/text_delta and tool_use events', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockSseResponse([
						'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":3,"output_tokens":0}}}',
						'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
						'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
						'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"search","input":{}}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":"}}',
						'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"cats\\"}"}}',
						'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
						'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":3,"output_tokens":12}}',
						'event: message_stop\ndata: {"type":"message_stop"}',
					]),
				),
		)

		const provider = new HttpProvider({
			baseURL: 'https://api.anthropic.com/v1',
			apiKey: 'k',
			dialect: 'anthropic',
		})

		const chunks = await collectStream(
			provider.chatStream({
				model: 'claude-sonnet-4',
				messages: [{ role: 'user', content: 'hi' }],
			}),
		)

		// Text accumulation
		const text = chunks.map((c) => c.delta.content ?? '').join('')
		expect(text).toBe('Hello')

		// Tool-call start emits an id + name with no arguments yet.
		const toolStart = chunks.find(
			(c) =>
				c.delta.toolCalls?.[0]?.id === 'tu_1' && c.delta.toolCalls[0].function?.name === 'search',
		)
		expect(toolStart).toBeDefined()

		// Tool-call argument fragments accumulate to a complete JSON string.
		const argFragments = chunks
			.flatMap((c) => c.delta.toolCalls ?? [])
			.map((tc) => tc.function?.arguments ?? '')
			.join('')
		expect(argFragments).toContain('{"q":"cats"}')

		// Final chunk carries finishReason='tool_calls'.
		const finalChunk = chunks.find((c) => c.finishReason !== undefined)
		expect(finalChunk?.finishReason).toBe('tool_calls')
	})

	it('openai streaming: first non-matching frame throws DialectMismatchError', async () => {
		// Frame has neither `choices` nor matches OpenAI shape.
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(mockSseResponse(['data: {"type":"message_start"}'])),
		)

		const provider = new HttpProvider({
			baseURL: 'https://example.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})

		await expect(
			collectStream(
				provider.chatStream({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
			),
		).rejects.toThrowError(DialectMismatchError)
	})
})

// ---------------------------------------------------------------------------
// Transport error taxonomy + AbortSignal forwarding (ses_015 Phase B)
//
// Current-code invariants asserted (2026-07-12, ses_015 Phase B):
//  - HttpProvider.chat() maps a non-2xx Response to ProviderRequestError with a
//    classified `kind` (throttle/server/auth/bad_request/context_overflow) and
//    the upstream `status` attached; DialectMismatchError is untouched.
//  - 429 carries retryAfterMs derived from the `Retry-After` header.
//  - A 400 whose body contains `context_length_exceeded` / "prompt is too long"
//    is classified context_overflow; a plain 400 is bad_request.
//  - A thrown fetch rejection maps: caller-signal / AbortError → 'aborted';
//    TimeoutError and TypeError('fetch failed') → 'network'.
//  - params.signal is composed with the internal timeout and forwarded on the
//    fetch options object (aborting the caller signal aborts the request).
// ---------------------------------------------------------------------------

function mockErrorResponse(
	body: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return new Response(body, { status, headers })
}

describe('@namzu/http — transport error taxonomy', () => {
	function newProvider(): HttpProvider {
		return new HttpProvider({
			baseURL: 'https://api.openai.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})
	}

	async function chatExpectError(provider: HttpProvider): Promise<ProviderRequestError> {
		try {
			await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
		} catch (err) {
			return err as ProviderRequestError
		}
		throw new Error('expected chat() to throw')
	}

	it('429 → kind "throttle" with status and retryAfterMs from Retry-After header', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(mockErrorResponse('{"error":"slow down"}', 429, { 'retry-after': '2' })),
		)
		const err = await chatExpectError(newProvider())
		expect(err).toBeInstanceOf(ProviderRequestError)
		expect(err.kind).toBe('throttle')
		expect(err.status).toBe(429)
		expect(err.retryAfterMs).toBe(2000)
		expect(err.providerId).toBe('http')
	})

	it('503 → kind "server"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockErrorResponse('upstream down', 503)))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('server')
		expect(err.status).toBe(503)
	})

	it('401 → kind "auth"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockErrorResponse('bad key', 401)))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('auth')
		expect(err.status).toBe(401)
	})

	it('400 with context_length_exceeded body → kind "context_overflow"', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockErrorResponse(
						'{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
						400,
					),
				),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('context_overflow')
		expect(err.status).toBe(400)
	})

	it('400 anthropic "prompt is too long" body → kind "context_overflow"', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					mockErrorResponse(
						'{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
						400,
					),
				),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('context_overflow')
	})

	it('plain 400 (no overflow marker) → kind "bad_request"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockErrorResponse('malformed request', 400)))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('bad_request')
		expect(err.status).toBe(400)
	})

	it('DOMException AbortError → kind "aborted"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('aborted')
	})

	it('caller signal already aborted → kind "aborted" (takes precedence)', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timeout', 'TimeoutError')))
		const controller = new AbortController()
		controller.abort()
		try {
			await newProvider().chat({
				model: 'm',
				messages: [{ role: 'user', content: 'hi' }],
				signal: controller.signal,
			})
			throw new Error('expected throw')
		} catch (e) {
			expect((e as ProviderRequestError).kind).toBe('aborted')
		}
	})

	it('DOMException TimeoutError → kind "network"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError')),
		)
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('network')
	})

	it('TypeError("fetch failed") → kind "network"', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
		const err = await chatExpectError(newProvider())
		expect(err.kind).toBe('network')
	})
})

describe('@namzu/http — AbortSignal forwarding', () => {
	it('composes params.signal with the internal timeout and forwards it to fetch', async () => {
		let captured: AbortSignal | undefined
		const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
			captured = init.signal
			return Promise.resolve(
				mockJsonResponse({
					id: 'x',
					model: 'm',
					choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
				}),
			)
		})
		vi.stubGlobal('fetch', fetchMock)

		const controller = new AbortController()
		const provider = new HttpProvider({
			baseURL: 'https://api.openai.com/v1',
			apiKey: 'k',
			dialect: 'openai',
		})

		await provider.chat({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
			signal: controller.signal,
		})

		expect(captured).toBeInstanceOf(AbortSignal)
		expect(captured?.aborted).toBe(false)
		// Aborting the caller signal must abort the composite forwarded to fetch.
		controller.abort()
		expect(captured?.aborted).toBe(true)
	})

	it('passes the internal timeout signal even when no caller signal is supplied', async () => {
		let captured: AbortSignal | undefined
		const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal?: AbortSignal }) => {
			captured = init.signal
			return Promise.resolve(
				mockJsonResponse({
					id: 'x',
					model: 'm',
					choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
				}),
			)
		})
		vi.stubGlobal('fetch', fetchMock)

		await new HttpProvider({ baseURL: 'https://api.openai.com/v1', apiKey: 'k' }).chat({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
		})

		expect(captured).toBeInstanceOf(AbortSignal)
	})
})
