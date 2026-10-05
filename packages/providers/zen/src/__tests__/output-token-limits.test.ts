import { type ChatCompletionParams, collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZenCatalogue } from '../catalogue/catalogue.js'
import { ZenProvider } from '../client.js'
import { type ZenProtocol, findZenModel } from '../models.js'

afterEach(() => vi.unstubAllGlobals())

/** Capture the native adapter's serialized request without model inference. */
async function requestBody(
	params: ChatCompletionParams,
	protocol: ZenProtocol,
	catalogue?: ZenCatalogue,
): Promise<Record<string, unknown>> {
	const transport = vi.fn<typeof fetch>(async () =>
		Response.json({ error: { message: 'Captured request fixture' } }, { status: 400 }),
	)
	vi.stubGlobal('fetch', transport)
	const provider = new ZenProvider({ apiKey: 'fixture', protocol, catalogue })
	await expect(collectChatCompletion(provider.chatStream(params))).rejects.toMatchObject({
		kind: 'bad_request',
	})
	expect(transport).toHaveBeenCalledOnce()
	return JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
}

function request(model: string, maxTokens?: number): ChatCompletionParams {
	return {
		model,
		messages: [{ role: 'user', content: 'Use the available tools to finish the task.' }],
		...(maxTokens !== undefined ? { maxTokens } : {}),
	}
}

function outputLimit(body: Record<string, unknown>, protocol: ZenProtocol): unknown {
	if (protocol === 'google') {
		return (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens
	}
	return body[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens']
}

describe('Zen output limits at the native HTTP boundary', () => {
	it.each([
		['chat', 'space-bunny-free', 524288],
		['responses', 'gpt-5.6-luna', 128000],
		['google', 'gemini-3.8-flash', 65536],
	] as const)(
		'requests the advertised %s ceiling when no caller limit is set',
		async (protocol, model, ceiling) => {
			const body = await requestBody(request(model), protocol)
			expect(outputLimit(body, protocol)).toBe(ceiling)
			if (protocol !== 'chat') expect(body).not.toHaveProperty('max_tokens')
			expect(body).not.toHaveProperty('max_completion_tokens')
			if (protocol !== 'responses') expect(body).not.toHaveProperty('max_output_tokens')
		},
	)

	it.each(['chat', 'responses', 'google'] as const)(
		'does not invent an output limit for an explicitly routed unknown %s model',
		async (protocol) => {
			const body = await requestBody(request('unknown-routed-model'), protocol)
			expect(outputLimit(body, protocol)).toBeUndefined()
		},
	)

	it.each([
		['chat', 'space-bunny-free'],
		['responses', 'gpt-5.6-luna'],
		['google', 'gemini-3.8-flash'],
		['messages', 'claude-haiku-4-5'],
	] as const)('preserves the caller-selected %s limit', async (protocol, model) => {
		const body = await requestBody(request(model, 8192), protocol)
		expect(outputLimit(body, protocol)).toBe(8192)
	})

	it('keeps Space Bunny effort and tools with its advertised output ceiling', async () => {
		const body = await requestBody(
			{
				...request('space-bunny-free'),
				effort: 'low',
				tools: [
					{
						type: 'function',
						function: {
							name: 'observe',
							description: 'Observe the computer.',
							parameters: { type: 'object', properties: {} },
						},
					},
				],
			},
			'chat',
		)
		expect(body).toMatchObject({
			max_tokens: 524288,
			reasoning_effort: 'low',
			tools: [{ type: 'function', function: { name: 'observe' } }],
		})
	})

	it.each([
		['claude-haiku-4-5', 64000],
		['qwen3.6-plus', 65536],
	] as const)('uses the known %s ceiling for required Messages max_tokens', async (model, cap) => {
		const body = await requestBody(request(model), 'messages')
		expect(body.max_tokens).toBe(cap)
	})

	it.each([undefined, 2048])(
		'keeps manual thinking inside the known Messages ceiling (budget %s)',
		async (budgetTokens) => {
			const body = await requestBody(
				{
					...request('claude-haiku-4-5'),
					thinking: { type: 'enabled', ...(budgetTokens ? { budgetTokens } : {}) },
				},
				'messages',
			)
			expect(body).toMatchObject({
				max_tokens: 64000,
				thinking: { type: 'enabled', budget_tokens: budgetTokens ?? 1024 },
			})
		},
	)

	it.each([
		[32000, 32000],
		[128000, 64000],
	])('respects refreshed Messages and native ceilings (%s)', async (advertised, expected) => {
		const bundled = findZenModel('zen', 'claude-haiku-4-5')
		if (!bundled) throw new Error('Expected the bundled Messages model')
		const catalogue: ZenCatalogue = {
			version: 1,
			fetchedAt: '2026-10-05T00:00:00.000Z',
			zen: [{ ...bundled, maxOutputTokens: advertised }],
			go: [],
			unrouted: { zen: [], go: [] },
		}
		const body = await requestBody(request(bundled.id), 'messages', catalogue)
		expect(body.max_tokens).toBe(expected)
	})

	it('requires an explicit limit for unknown Messages models before any request', async () => {
		const transport = vi.fn()
		vi.stubGlobal('fetch', transport)
		const provider = new ZenProvider({ apiKey: 'fixture', protocol: 'messages' })
		await expect(
			collectChatCompletion(provider.chatStream(request('unknown-routed-model'))),
		).rejects.toMatchObject({
			kind: 'bad_request',
			detail: 'This messages model has no known output limit; set maxTokens explicitly.',
		})
		expect(transport).not.toHaveBeenCalled()
		const body = await requestBody(request('unknown-routed-model', 8192), 'messages')
		expect(body.max_tokens).toBe(8192)
	})

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects an invalid explicit limit (%s) before any request',
		async (maxTokens) => {
			const transport = vi.fn()
			vi.stubGlobal('fetch', transport)
			await expect(
				collectChatCompletion(new ZenProvider().chatStream(request('space-bunny-free', maxTokens))),
			).rejects.toMatchObject({ kind: 'bad_request' })
			expect(transport).not.toHaveBeenCalled()
		},
	)
})
