import { createAssistantMessage, createToolMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { GoogleProvider } from './client.js'
import { buildRequest } from './wire.js'
const model = 'gemini-2.5-flash'
function response(events: unknown[]) {
	return new Response(events.map((x) => `data: ${JSON.stringify(x)}\r\n\r\n`).join(''), {
		headers: { 'content-type': 'text/event-stream' },
	})
}
async function collect(provider: GoogleProvider, messages = [createUserMessage('hi')]) {
	const chunks = []
	for await (const c of provider.chatStream({ model, messages })) chunks.push(c)
	return chunks
}
describe('native Gemini transport', () => {
	it('discovers existing Code Assist account and sends native envelope without API key', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				Response.json({
					currentTier: { id: 'free-tier' },
					cloudaicompanionProject: 'managed-project',
				}),
			)
			.mockResolvedValueOnce(
				response([
					{
						response: {
							candidates: [
								{
									content: { parts: [{ text: 'hello' }] },
									finishReason: 'STOP',
								},
							],
						},
					},
				]),
			)
		const getAccessToken = vi.fn().mockResolvedValue('token')
		const chunks = await collect(new GoogleProvider({ getAccessToken, fetch }))
		expect(chunks[0]?.delta.content).toBe('hello')
		expect(fetch.mock.calls[0]?.[0]).toContain(':loadCodeAssist')
		const init = fetch.mock.calls[1]?.[1]
		expect(JSON.parse(String(init?.body))).toMatchObject({
			project: 'managed-project',
			model,
			request: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
		})
		expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' })
		expect(init?.signal).toBeInstanceOf(AbortSignal)
	})
	it('does not onboard uninitialized accounts', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(Response.json({ allowedTiers: [{ id: 'paid' }] }))
		await expect(
			collect(new GoogleProvider({ getAccessToken: async () => 'token', fetch })),
		).rejects.toThrow('automatic onboarding')
		expect(fetch).toHaveBeenCalledTimes(1)
	})
	it('replays signed native parts only on the original unmodified route', async () => {
		const signed = {
			functionCall: { name: 'read', args: { path: 'a' } },
			thoughtSignature: 'signature',
		}
		const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
			response([
				{
					candidates: [
						{
							content: {
								parts: [{ thought: true, text: 'summary' }, { text: 'checking' }, signed],
							},
							finishReason: 'STOP',
						},
					],
					usageMetadata: {
						promptTokenCount: 5,
						candidatesTokenCount: 3,
						thoughtsTokenCount: 2,
						totalTokenCount: 10,
					},
				},
			]),
		)
		const chunks = await collect(new GoogleProvider({ apiKey: 'key', fetch }))
		const last = chunks.at(-1)
		expect(last?.usage?.completionTokens).toBe(5)
		expect(last?.finishReason).toBe('tool_calls')
		const callChunk = chunks.find((c) => c.delta.toolCalls)?.delta.toolCalls?.[0]
		const call = {
			id: callChunk?.id as string,
			type: 'function' as const,
			function: { name: 'read', arguments: '{"path":"a"}' },
		}
		const source = {
			type: 'model' as const,
			providerId: 'google',
			model,
			chainIndex: 0,
			replayState: last?.replayState,
		}
		const assistant = createAssistantMessage('checking', [call], undefined, undefined, source)
		const request = buildRequest({
			model,
			messages: [createUserMessage('hi'), assistant, createToolMessage('ok', call.id)],
		}) as { contents: Array<{ parts: unknown[] }> }
		expect(request.contents[1]?.parts).toContainEqual(signed)
		expect(request.contents[2]?.parts[0]).toEqual({
			functionResponse: { name: 'read', response: { output: 'ok' } },
		})
		assistant.content = 'edited'
		expect(JSON.stringify(buildRequest({ model, messages: [assistant] }))).not.toContain(
			'signature',
		)
		assistant.content = 'checking'
		expect(
			JSON.stringify(
				buildRequest({
					model,
					providerRoute: { providerId: 'google', model, chainIndex: 1 },
					messages: [assistant],
				}),
			),
		).not.toContain('signature')
	})
	it('rejects premature EOF and redacts HTTP response bodies', async () => {
		await expect(
			collect(
				new GoogleProvider({
					apiKey: 'key',
					fetch: async () =>
						response([{ candidates: [{ content: { parts: [{ text: 'partial' }] } }] }]),
				}),
			),
		).rejects.toThrow('terminal finish')
		await expect(
			collect(
				new GoogleProvider({
					apiKey: 'key',
					fetch: async () => new Response('secret-account', { status: 401 }),
				}),
			),
		).rejects.toMatchObject({
			status: 401,
		})
	})
	it('cancels before obtaining credentials or fetching', async () => {
		const controller = new AbortController()
		controller.abort()
		const fetch = vi.fn()
		const provider = new GoogleProvider({ apiKey: 'key', fetch })
		await expect(
			(async () => {
				for await (const _ of provider.chatStream({
					model,
					messages: [],
					signal: controller.signal,
				})) {
				}
			})(),
		).rejects.toThrow()
		expect(fetch).not.toHaveBeenCalled()
	})
	it('maps native JSON schema and rejects unimplemented controls before transport', () => {
		expect(
			buildRequest({
				model,
				messages: [],
				responseFormat: {
					type: 'json_schema',
					json_schema: { name: 'answer', schema: { type: 'object' } },
				},
			}),
		).toMatchObject({
			generationConfig: {
				responseMimeType: 'application/json',
				responseJsonSchema: { type: 'object' },
			},
		})
		expect(() => buildRequest({ model, messages: [], effort: 'low' })).toThrow(
			'does not publish effort',
		)
		expect(() => buildRequest({ model, messages: [], parallelToolCalls: false })).toThrow(
			'parallelToolCalls',
		)
	})
	it('preserves retry hints and rejects malformed model termination', async () => {
		await expect(
			collect(
				new GoogleProvider({
					apiKey: 'key',
					fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '7' } }),
				}),
			),
		).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 })
		await expect(
			collect(
				new GoogleProvider({
					apiKey: 'key',
					fetch: async () =>
						response([{ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL' }] }]),
				}),
			),
		).rejects.toThrow('MALFORMED_FUNCTION_CALL')
	})
	it('handles CRLF SSE boundaries split across bytes', async () => {
		const bytes = new TextEncoder().encode(
			'data: {"candidates":[{"content":{"parts":[{"text":"İyi"}]},"finishReason":"STOP"}]}\r\n\r\n',
		)
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
				controller.close()
			},
		})
		const chunks = await collect(
			new GoogleProvider({ apiKey: 'key', fetch: async () => new Response(stream) }),
		)
		expect(chunks[0]?.delta.content).toBe('İyi')
	})
	it('accepts kernel automatic caching but probes even with a configured project', async () => {
		expect(() =>
			buildRequest({ model, messages: [], cacheControl: { type: 'auto' } }),
		).not.toThrow()
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValue(new Response('', { status: 401 }))
		await expect(
			new GoogleProvider({
				projectId: 'known',
				getAccessToken: async () => 'bad',
				fetch,
			}).probeCredential(),
		).rejects.toMatchObject({ status: 401 })
		expect(fetch).toHaveBeenCalledTimes(1)
	})
	it('discovers a fresh project for each OAuth generation using one token snapshot', async () => {
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockResolvedValueOnce(
				Response.json({ currentTier: { id: 'free' }, cloudaicompanionProject: 'one' }),
			)
			.mockResolvedValueOnce(response([{ response: { candidates: [{ finishReason: 'STOP' }] } }]))
			.mockResolvedValueOnce(
				Response.json({ currentTier: { id: 'free' }, cloudaicompanionProject: 'two' }),
			)
			.mockResolvedValueOnce(response([{ response: { candidates: [{ finishReason: 'STOP' }] } }]))
		const getAccessToken = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second')
		const provider = new GoogleProvider({ fetch, getAccessToken })
		await collect(provider)
		await collect(provider)
		expect(getAccessToken).toHaveBeenCalledTimes(2)
		expect(JSON.parse(String(fetch.mock.calls[3]?.[1]?.body)).project).toBe('two')
		expect(fetch.mock.calls[2]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer second' })
		expect(fetch.mock.calls[3]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer second' })
	})
	it('echoes a native function ID rather than replacing it with a runtime ID', async () => {
		const native = {
			functionCall: { id: 'google-call', name: 'read', args: {} },
			thoughtSignature: 'signed',
		}
		const provider = new GoogleProvider({
			apiKey: 'key',
			fetch: async () =>
				response([{ candidates: [{ content: { parts: [native] }, finishReason: 'STOP' }] }]),
		})
		const chunks = await collect(provider)
		const call = {
			id: 'google-call',
			type: 'function' as const,
			function: { name: 'read', arguments: '{}' },
		}
		const assistant = createAssistantMessage(null, [call], undefined, undefined, {
			type: 'model',
			providerId: 'google',
			model,
			chainIndex: 0,
			replayState: chunks.at(-1)?.replayState,
		})
		const request = buildRequest({
			model,
			messages: [assistant, createToolMessage('ok', call.id)],
			enforceToolInputSchema: ['read'],
		}) as { contents: Array<{ parts: unknown[] }> }
		expect(request.contents[1]?.parts[0]).toEqual({
			functionResponse: { id: 'google-call', name: 'read', response: { output: 'ok' } },
		})
	})
})
