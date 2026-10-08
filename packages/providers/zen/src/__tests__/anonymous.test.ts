import { collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZenCatalogue } from '../catalogue/catalogue.js'
import { ZenGoProvider, ZenProvider } from '../client.js'
import { type ZenProtocol, findZenModel, getZenModels } from '../models.js'
import type { ZenGoConfig, ZenGoProviderConfig } from '../types.js'

const freeMuse = 'muse-spark-1.3-contributor-free'
const defaultFree = 'space-bunny-free'
// Dynamic system: any model with zero input and output price is available anonymously
const anonymousIds = [defaultFree, freeMuse, 'big-pickle']
const experimentalAgent = 'opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'
const params = {
	model: '',
	messages: [{ role: 'user' as const, content: 'Hello' }],
}

/** The endpoint the roster routes a model to. */
function wirePath(model: string): string {
	switch (findZenModel('zen', model)?.protocol) {
		case 'responses':
			return 'responses'
		case 'messages':
			return 'messages'
		default:
			return 'chat/completions'
	}
}

function nativeResponse(url: string, model: string): Response {
	const frames = url.endsWith('/responses')
		? [
				{
					type: 'response.created',
					response: { id: 'anonymous-response', created_at: 1, model },
				},
				{
					type: 'response.output_item.added',
					output_index: 0,
					item: { type: 'message', id: 'message-1' },
				},
				{
					type: 'response.output_text.delta',
					item_id: 'message-1',
					delta: 'Ready.',
				},
				{
					type: 'response.output_item.done',
					output_index: 0,
					item: { type: 'message', id: 'message-1' },
				},
				{
					type: 'response.completed',
					response: {
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			]
		: url.endsWith('/messages')
			? [
					{
						type: 'message_start',
						message: {
							id: 'anonymous-message',
							type: 'message',
							role: 'assistant',
							model,
							content: [],
							stop_reason: null,
							stop_sequence: null,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{
						type: 'content_block_start',
						index: 0,
						content_block: { type: 'text', text: '' },
					},
					{
						type: 'content_block_delta',
						index: 0,
						delta: { type: 'text_delta', text: 'Ready.' },
					},
					{ type: 'content_block_stop', index: 0 },
					{
						type: 'message_delta',
						delta: { stop_reason: 'end_turn', stop_sequence: null },
						usage: { output_tokens: 1 },
					},
					{ type: 'message_stop' },
				]
			: [
					{
						id: 'anonymous-chat',
						choices: [
							{
								index: 0,
								delta: { role: 'assistant', content: 'Ready.' },
								finish_reason: 'stop',
							},
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

function expectNamzuIdentity(init: RequestInit | undefined, sessionId: string) {
	const headers = new Headers(init?.headers)
	expect(headers.get('user-agent')).toMatch(/^namzu\//)
	expect(headers.get('x-opencode-session')).toBe(sessionId)
	expect(headers.get('x-opencode-client')).toBeNull()
	expect(headers.get('x-opencode-project')).toBeNull()
	expect(headers.get('x-opencode-request')).toBeNull()
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('anonymous Zen access', () => {
	it.each([undefined, '', ' \t ', 'public', ' public '])(
		'uses the verified free default and the public sentinel for credential %j',
		async (apiKey) => {
			const transport = mockNativeFetch()
			const provider = apiKey === undefined ? new ZenProvider() : new ZenProvider({ apiKey })
			const result = await collectChatCompletion(provider.chatStream(params))
			expect(result.message.content).toBe('Ready.')
			expect(result.finishReason).toBe('stop')
			expect(transport).toHaveBeenCalledTimes(1)
			const request = transport.mock.calls[0]
			if (!request) throw new Error('Expected a model request')
			expect(request[0]).toBe('https://opencode.ai/zen/v1/chat/completions')
			expect(JSON.parse(String(request[1]?.body)).model).toBe(defaultFree)
			expect(new Headers(request[1]?.headers).get('authorization')).toBe('Bearer public')
			expectNamzuIdentity(request[1], provider.sessionId)
		},
	)

	it.each(anonymousIds)(
		'admits curated %s through a caller-owned proxy without OpenCode identity headers',
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
			// The roster supplies the route; Muse uses Responses while the others use Chat.
			expect(request[0]).toBe(`https://proxy.example/zen/v1/${wirePath(model)}`)
			expect(JSON.parse(String(request[1]?.body)).model).toBe(model)
			const headers = new Headers(request[1]?.headers)
			// The sentinel travels in the header its wire uses: the Anthropic
			// adapter authenticates with x-api-key, the other two with a bearer.
			if (wirePath(model) === 'messages') {
				expect(headers.get('x-api-key')).toBe('public')
			} else {
				expect(headers.get('authorization')).toBe('Bearer public')
			}
			expect(headers.get('x-opencode-session')).toBe('public-conversation')
			expectNamzuIdentity(request[1], 'public-conversation')
		},
	)

	it('sends pinned OpenCode identity for any 0-price model on the official Zen host', async () => {
		const transport = mockNativeFetch()
		// Any model with zero input/output price uses experimental identity
		const provider = new ZenProvider({ model: 'big-pickle', sessionId: 'free-model-test' })
		const result = await collectChatCompletion(provider.chatStream(params))
		expect(result.message.content).toBe('Ready.')
		expect(transport).toHaveBeenCalledTimes(1)
		const request = transport.mock.calls[0]
		if (!request) throw new Error('Expected a model request')
		expect(JSON.parse(String(request[1]?.body)).model).toBe('big-pickle')
		const headers = new Headers(request[1]?.headers)
		expect(headers.get('authorization')).toBe('Bearer public')
		expect(headers.get('user-agent')).toBe(experimentalAgent)
		expect(headers.get('x-opencode-client')).toBe('cli')
		expect(headers.get('x-opencode-project')).toBe('global')
	})

	it('keeps the experimental session stable across provider constructions and changes each request ID', async () => {
		const transport = mockNativeFetch()
		const first = new ZenProvider({ model: 'big-pickle', sessionId: 'same-conversation' })
		await collectChatCompletion(first.chatStream(params))
		await collectChatCompletion(first.chatStream(params))
		const restored = new ZenProvider({ model: freeMuse, sessionId: 'same-conversation' })
		await collectChatCompletion(restored.chatStream(params))
		const other = new ZenProvider({ model: freeMuse, sessionId: 'different-conversation' })
		await collectChatCompletion(other.chatStream(params))
		const requests = transport.mock.calls.map(([, init]) => new Headers(init?.headers))
		expect(requests).toHaveLength(4)
		const sessions = requests.map((headers) => headers.get('x-opencode-session'))
		expect(sessions[0]).toBe(sessions[1])
		expect(sessions[1]).toBe(sessions[2])
		expect(sessions[3]).not.toBe(sessions[0])
		const requestIds = requests.map((headers) => headers.get('x-opencode-request'))
		expect(new Set(requestIds).size).toBe(4)
	})

	it('keeps pinned identity off keyed Zen, Zen Go, and model catalogue requests', async () => {
		const transport = vi.fn<typeof fetch>(async (input, init) =>
			String(input).endsWith('/models')
				? Response.json({ data: [{ id: defaultFree }, { id: freeMuse }] })
				: nativeResponse(String(input), JSON.parse(String(init?.body)).model),
		)
		vi.stubGlobal('fetch', transport)
		const keyed = new ZenProvider({ apiKey: 'fixture', model: freeMuse, sessionId: 'keyed' })
		await collectChatCompletion(keyed.chatStream(params))
		const go = new ZenGoProvider({ apiKey: 'fixture', model: 'glm-5.3-flash', sessionId: 'go' })
		await collectChatCompletion(go.chatStream(params))
		const anonymous = new ZenProvider({ sessionId: 'discovery' })
		expect((await anonymous.listModels()).map(({ id }) => id)).toEqual([defaultFree, freeMuse])
		expect(transport).toHaveBeenCalledTimes(3)
		expectNamzuIdentity(transport.mock.calls[0]?.[1], 'keyed')
		expectNamzuIdentity(transport.mock.calls[1]?.[1], 'go')
		expectNamzuIdentity(transport.mock.calls[2]?.[1], 'discovery')
		expect(transport.mock.calls[2]?.[0]).toBe('https://opencode.ai/zen/v1/models')
	})

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
						new ZenProvider({ model: freeMuse, protocol }).chatStream({
							...params,
							model,
						}),
					),
				).rejects.toMatchObject({ kind: 'auth' })
			}
			expect(transport).not.toHaveBeenCalled()
		},
	)

	it('lists only the eight curated models that are still served', async () => {
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json({
				data: [
					{ id: 'glm-5.3-flash' },
					{ id: 'future-free' },
					...anonymousIds.map((id) => ({ id })),
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
		).toEqual([defaultFree])
		expect(getZenModels('go').some((model) => model.supportsAnonymousAccess === true)).toBe(false)
		expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
			'Bearer public',
		)
		transport.mockResolvedValueOnce(Response.json({ data: [{ id: 'glm-5.3-flash' }] }))
		await expect(new ZenProvider().listModels()).resolves.toEqual([])
	})

	it('withdraws verified direct access when a refreshed catalogue reprices Space Bunny', async () => {
		const spaceBunny = findZenModel('zen', defaultFree)
		if (!spaceBunny) throw new Error('Expected bundled Space Bunny model')
		const catalogue: ZenCatalogue = {
			version: 1,
			fetchedAt: new Date(0).toISOString(),
			zen: [{ ...spaceBunny, inputPrice: 1, supportsAnonymousAccess: true }],
			go: [],
			unrouted: { zen: [], go: [] },
		}
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json({ data: [{ id: defaultFree }] }),
		)
		vi.stubGlobal('fetch', transport)
		const anonymous = new ZenProvider({ catalogue })
		await expect(
			collectChatCompletion(anonymous.chatStream({ ...params, model: defaultFree })),
		).rejects.toMatchObject({ kind: 'auth' })
		expect(transport).not.toHaveBeenCalled()
		expect(await anonymous.listModels()).toEqual([])
		expect(transport).toHaveBeenCalledTimes(1)
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
				{
					error: {
						type: 'authentication_error',
						message: `Invalid key ${key}`,
					},
				},
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
