import type { ChatCompletionParams } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenGoProvider, ZenProvider } from '../client.js'
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
			createCallOptions({ ...params, effort: 'low' }, route, 'zen', 'chat').providerOptions,
		).toEqual({ opencode: { reasoningEffort: 'low' } })
		expect(() => createCallOptions({ ...params, effort: 'medium' }, route, 'zen', 'chat')).toThrow(
			'does not advertise',
		)
	})

	it('keeps stateless native Responses reasoning and explicit parallel tool intent', () => {
		const model = 'gpt-5.6-luna'
		const result = createCallOptions(
			{ ...params, model, effort: 'low', parallelToolCalls: false },
			{ ...route, model },
			'zen',
			'responses',
		)
		expect(result.providerOptions?.openai).toMatchObject({
			store: false,
			include: ['reasoning.encrypted_content'],
			reasoningEffort: 'low',
			parallelToolCalls: false,
		})
		expect(result.maxOutputTokens).toBe(4096)
	})

	it('rejects unsupported intent instead of spending on a degraded request', async () => {
		const transport = vi.fn()
		vi.stubGlobal('fetch', transport)
		const provider = new ZenProvider({ apiKey: 'fixture', sessionId: 'conversation' })
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
							{ type: 'stored', kind: 'image', ref: 'unresolved', mediaType: 'image/png' },
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
		const provider = new ZenGoProvider({ apiKey: 'fixture', sessionId: 'conversation' })
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
