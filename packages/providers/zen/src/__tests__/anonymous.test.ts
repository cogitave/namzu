import { collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenGoProvider, ZenProvider } from '../client.js'
import { type ZenProtocol, getZenModels } from '../models.js'
import type { ZenGoConfig, ZenGoProviderConfig } from '../types.js'

const freeMuse = 'muse-spark-1.3-contributor-free'
const anonymousIds = [
	'big-pickle',
	'mimo-v2.5-free',
	'ling-3.0-flash-fin-free',
	'nemotron-3-ultra-free',
	'nemotron-3.5-lightning-free',
	freeMuse,
]
const params = { model: '', messages: [{ role: 'user' as const, content: 'Hello' }] }

function nativeResponse(url: string, model: string): Response {
	const frames = url.endsWith('/responses')
		? [
				{ type: 'response.created', response: { id: 'anonymous-response', created_at: 1, model } },
				{
					type: 'response.output_item.added',
					output_index: 0,
					item: { type: 'message', id: 'message-1' },
				},
				{ type: 'response.output_text.delta', item_id: 'message-1', delta: 'Ready.' },
				{
					type: 'response.output_item.done',
					output_index: 0,
					item: { type: 'message', id: 'message-1' },
				},
				{
					type: 'response.completed',
					response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
				},
			]
		: [
				{
					id: 'anonymous-chat',
					choices: [
						{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' },
					],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				},
			]
	return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
		headers: { 'content-type': 'text/event-stream' },
	})
}

function mockNativeFetch() {
	const transport = vi.fn<typeof fetch>(async (input, init) => {
		const body = JSON.parse(String(init?.body)) as { model: string }
		return nativeResponse(String(input), body.model)
	})
	vi.stubGlobal('fetch', transport)
	return transport
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('anonymous Zen access', () => {
	it.each([undefined, '', ' \t ', 'public', ' public '])(
		'uses free Muse and the public sentinel for credential %j',
		async (apiKey) => {
			const transport = mockNativeFetch()
			const provider = apiKey === undefined ? new ZenProvider() : new ZenProvider({ apiKey })
			const result = await collectChatCompletion(provider.chatStream(params))
			expect(result.message.content).toBe('Ready.')
			expect(result.finishReason).toBe('stop')
			expect(transport).toHaveBeenCalledTimes(1)
			const request = transport.mock.calls[0]
			if (!request) throw new Error('Expected a model request')
			expect(request[0]).toBe('https://opencode.ai/zen/v1/responses')
			expect(JSON.parse(String(request[1]?.body)).model).toBe(freeMuse)
			expect(new Headers(request[1]?.headers).get('authorization')).toBe('Bearer public')
			expect(new Headers(request[1]?.headers).get('user-agent')).toMatch(/^namzu\//)
		},
	)

	it.each(anonymousIds)(
		'admits explicitly supported %s through a caller-owned proxy',
		async (model) => {
			const transport = mockNativeFetch()
			const provider = new ZenProvider({
				model,
				baseURL: 'https://proxy.example/zen/v1',
				sessionId: 'public-conversation',
			})
			await collectChatCompletion(provider.chatStream(params))
			const request = transport.mock.calls[0]
			if (!request) throw new Error('Expected a model request')
			expect(request[0]).toBe(
				`https://proxy.example/zen/v1/${model === freeMuse ? 'responses' : 'chat/completions'}`,
			)
			expect(JSON.parse(String(request[1]?.body)).model).toBe(model)
			const headers = new Headers(request[1]?.headers)
			expect(headers.get('authorization')).toBe('Bearer public')
			expect(headers.get('x-opencode-session')).toBe('public-conversation')
		},
	)

	it.each(['chat', 'responses', 'messages', 'google'] satisfies ZenProtocol[])(
		'refuses paid and unknown models before fetch even with a %s override',
		async (protocol) => {
			const transport = mockNativeFetch()
			for (const model of ['glm-5.3-flash', 'muse-spark-1.3', 'future-free']) {
				const provider = new ZenProvider({ apiKey: 'public', model, protocol })
				await expect(collectChatCompletion(provider.chatStream(params))).rejects.toMatchObject({
					kind: 'auth',
					providerId: 'zen',
				})
				await expect(
					collectChatCompletion(
						new ZenProvider({ model: freeMuse, protocol }).chatStream({ ...params, model }),
					),
				).rejects.toMatchObject({ kind: 'auth' })
			}
			expect(transport).not.toHaveBeenCalled()
		},
	)

	it('lists only explicit anonymous models that are still present in the live catalogue', async () => {
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json({
				data: [
					{ id: 'glm-5.3-flash' },
					{ id: 'future-free' },
					...anonymousIds.map((id) => ({ id })),
					{ id: freeMuse },
				],
			}),
		)
		vi.stubGlobal('fetch', transport)
		const models = await new ZenProvider().listModels()
		expect(models.map(({ id }) => id)).toEqual(anonymousIds)
		expect(
			getZenModels('zen')
				.filter((model) => model.supportsAnonymousAccess === true)
				.map(({ id }) => id),
		).toEqual(anonymousIds)
		expect(getZenModels('go').some((model) => model.supportsAnonymousAccess === true)).toBe(false)
		expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
			'Bearer public',
		)
		transport.mockResolvedValueOnce(Response.json({ data: [{ id: 'glm-5.3-flash' }] }))
		await expect(new ZenProvider().listModels()).resolves.toEqual([])
	})

	it('keeps the paid default and full supported discovery for a genuine credential', async () => {
		const transport = mockNativeFetch()
		const provider = new ZenProvider({ apiKey: 'fixture-key' })
		await collectChatCompletion(provider.chatStream(params))
		expect(transport.mock.calls[0]?.[0]).toBe('https://opencode.ai/zen/v1/chat/completions')
		expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body)).model).toBe('glm-5.3-flash')
		expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
			'Bearer fixture-key',
		)
		transport.mockResolvedValueOnce(
			Response.json({ data: [{ id: freeMuse }, { id: 'glm-5.3-flash' }] }),
		)
		expect((await provider.listModels()).map(({ id }) => id)).toEqual([freeMuse, 'glm-5.3-flash'])
	})

	it('never retries an invalid supplied credential as anonymous, even on a free model', async () => {
		const key = 'invalid-fixture-key'
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json(
				{ error: { type: 'authentication_error', message: `Invalid key ${key}` } },
				{ status: 401 },
			),
		)
		vi.stubGlobal('fetch', transport)
		const provider = new ZenProvider({ apiKey: key })
		for (const model of ['', freeMuse]) {
			let caught: unknown
			try {
				await collectChatCompletion(provider.chatStream({ ...params, model }))
			} catch (error) {
				caught = error
			}
			expect(caught).toMatchObject({ kind: 'auth', status: 401 })
			expect(JSON.stringify(caught)).not.toContain(key)
		}
		expect(transport).toHaveBeenCalledTimes(2)
		for (const [, init] of transport.mock.calls)
			expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${key}`)
	})

	it.each(['', 'public'])(
		'preserves anonymous server error classification without treating %j as a secret',
		async (apiKey) => {
			const transport = vi.fn<typeof fetch>(async () =>
				Response.json(
					{
						error: {
							type: 'rate_limit_error',
							code: 'public_limit',
							message: 'Public quota reached.',
						},
					},
					{ status: 429, headers: { 'retry-after': '7' } },
				),
			)
			vi.stubGlobal('fetch', transport)
			await expect(
				collectChatCompletion(new ZenProvider({ apiKey }).chatStream(params)),
			).rejects.toMatchObject({
				kind: 'throttle',
				status: 429,
				retryAfterMs: 7_000,
				providerCode: 'public_limit',
			})
			expect(transport).toHaveBeenCalledTimes(1)
		},
	)

	it('retains required Go credentials in the public types and at runtime', () => {
		// @ts-expect-error A Go configuration must carry an API key.
		const missingKey: ZenGoConfig = {}
		// @ts-expect-error Registry Go configuration retains the required API key.
		const missingRegistryKey: ZenGoProviderConfig = { type: 'zen-go' }
		expect(() => new ZenGoProvider(missingKey)).toThrow('Zen Go requires an API key')
		expect(() => new ZenGoProvider(missingRegistryKey)).toThrow('Zen Go requires an API key')
		for (const apiKey of ['', ' \t ', 'public', ' public ']) {
			expect(() => new ZenGoProvider({ apiKey })).toThrow('Zen Go requires an API key')
			expect(() => new ZenProvider({ apiKey }, 'go')).toThrow('Zen Go requires an API key')
		}
		expect(() => new ZenGoProvider({ apiKey: 'fixture-key' })).not.toThrow()
	})
})
