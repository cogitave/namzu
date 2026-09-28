import { type ChatCompletionParams, collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ZenCatalogue } from '../catalogue/catalogue.js'
import { ZenGoProvider, ZenProvider } from '../client.js'
import { findZenModel } from '../models.js'
import { createCallOptions } from '../options.js'

const params: ChatCompletionParams = {
	model: 'glm-5.3-flash',
	messages: [{ role: 'user', content: 'Hello' }],
}
const route = { providerId: 'zen', model: params.model, chainIndex: 0 }
afterEach(() => vi.unstubAllGlobals())

describe('request intent and model discovery', () => {
	it('maps the advertised GLM effort without inventing a medium level', () => {
		expect(
			createCallOptions(
				{ ...params, effort: 'low' },
				route,
				'zen',
				'chat',
				findZenModel('zen', params.model),
			).providerOptions,
		).toEqual({ opencode: { reasoningEffort: 'low' } })
		expect(() =>
			createCallOptions(
				{ ...params, effort: 'medium' },
				route,
				'zen',
				'chat',
				findZenModel('zen', params.model),
			),
		).toThrow('does not advertise')
	})

	it('keeps stateless native Responses reasoning and explicit parallel tool intent', () => {
		const model = 'gpt-5.6-luna'
		const result = createCallOptions(
			{ ...params, model, effort: 'low', parallelToolCalls: false },
			{ ...route, model },
			'zen',
			'responses',
			findZenModel('zen', model),
		)
		expect(result.providerOptions?.openai).toMatchObject({
			store: false,
			include: ['reasoning.encrypted_content'],
			reasoningEffort: 'low',
			parallelToolCalls: false,
		})
		expect(result.maxOutputTokens).toBe(4096)
	})

	it.each([
		['zen', 'muse-spark-1.3-contributor-free'],
		['go', 'muse-spark-1.3-contributor'],
	] as const)('%s Muse Spark does not request encrypted Responses reasoning', (service, model) => {
		const result = createCallOptions(
			{ ...params, model, effort: 'low' },
			{
				providerId: service === 'go' ? 'zen-go' : 'zen',
				model,
				chainIndex: 0,
			},
			service,
			'responses',
			findZenModel(service, model),
		)
		expect(result.providerOptions?.openai).toMatchObject({
			store: false,
			reasoningEffort: 'low',
		})
		expect(result.providerOptions?.openai).not.toHaveProperty('include')
	})

	it('rejects unsupported intent instead of spending on a degraded request', async () => {
		const transport = vi.fn()
		vi.stubGlobal('fetch', transport)
		const provider = new ZenProvider({
			apiKey: 'fixture',
			sessionId: 'conversation',
		})
		await expect(async () => {
			for await (const _ of provider.chatStream({ ...params, topK: 10 })) {
			}
		}).rejects.toMatchObject({ kind: 'bad_request' })
		await expect(async () => {
			for await (const _ of provider.chatStream({
				...params,
				messages: [
					{
						role: 'user',
						content: '',
						attachments: [
							{
								type: 'stored',
								kind: 'image',
								ref: 'unresolved',
								mediaType: 'image/png',
							},
						],
					},
				],
			})) {
			}
		}).rejects.toMatchObject({ kind: 'bad_request' })
		expect(transport).not.toHaveBeenCalled()
	})

	it('does not infer a protocol for an unknown model', async () => {
		const transport = vi.fn()
		vi.stubGlobal('fetch', transport)
		await expect(async () => {
			for await (const _ of new ZenProvider({ apiKey: 'fixture' }).chatStream({
				...params,
				model: 'gpt-new-alias',
			})) {
			}
		}).rejects.toMatchObject({ kind: 'bad_request' })
		expect(transport).not.toHaveBeenCalled()
	})

	it('intersects the live catalogue with supported metadata without duplicating or inventing models', async () => {
		const transport = vi.fn(async () =>
			Response.json({
				data: [{ id: 'glm-5.3-flash' }, { id: 'future-unknown' }, { id: 'glm-5.3-flash' }],
			}),
		)
		vi.stubGlobal('fetch', transport)
		const provider = new ZenGoProvider({
			apiKey: 'fixture',
			sessionId: 'conversation',
		})
		const models = await provider.listModels()
		expect(models.map((model) => model.id)).toEqual(['glm-5.3-flash'])
		expect(models[0]?.contextWindow).toBe(1_000_000)
		expect(transport).toHaveBeenCalledWith(
			'https://opencode.ai/zen/go/v1/models',
			expect.objectContaining({ redirect: 'error' }),
		)
	})

	it('does not treat a public catalogue as proof that the credential works', () => {
		const provider = new ZenProvider({ apiKey: 'fixture' })
		expect('probeCredential' in provider).toBe(false)
	})

	it('uses runtime effort levels for validation and forces reasoning on a newly discovered Responses model', async () => {
		const bundled = findZenModel('zen', 'gpt-5.6-luna')
		if (!bundled) throw new Error('Expected bundled Responses fixture model')
		const catalogue: ZenCatalogue = {
			version: 1,
			fetchedAt: '2026-09-28T00:00:00.000Z',
			zen: [
				{ ...bundled, effortLevels: ['high'] },
				{ ...bundled, id: 'future-reasoning-model', effortLevels: ['high'] },
			],
			go: [],
			unrouted: { zen: [], go: [] },
		}
		const transport = vi.fn<typeof fetch>(async () =>
			Response.json({ error: { message: 'fixture request captured' } }, { status: 400 }),
		)
		vi.stubGlobal('fetch', transport)
		const provider = new ZenProvider({ apiKey: 'fixture', catalogue })
		await expect(
			collectChatCompletion(provider.chatStream({ ...params, model: bundled.id, effort: 'low' })),
		).rejects.toMatchObject({ kind: 'bad_request' })
		expect(transport).not.toHaveBeenCalled()
		await expect(
			collectChatCompletion(
				provider.chatStream({
					...params,
					model: 'future-reasoning-model',
					effort: 'high',
				}),
			),
		).rejects.toMatchObject({ kind: 'bad_request' })
		expect(transport).toHaveBeenCalledTimes(1)
		const body = JSON.parse(String(transport.mock.calls[0]?.[1]?.body))
		expect(body).toMatchObject({
			model: 'future-reasoning-model',
			reasoning: { effort: 'high' },
			include: ['reasoning.encrypted_content'],
		})
	})

	it('bounds chunked catalogue bodies and closes them after rejection', async () => {
		const cancel = vi.fn()
		vi.stubGlobal(
			'fetch',
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(1_048_577))
						},
						cancel,
					}),
				),
		)
		await expect(new ZenProvider({ apiKey: 'fixture' }).listModels()).rejects.toThrow(
			'exceeds 1 MiB',
		)
		expect(cancel).toHaveBeenCalledOnce()
	})
})
