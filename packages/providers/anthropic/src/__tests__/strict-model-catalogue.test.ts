import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider, OFFLINE_MODEL_CATALOGUE } from '../client.js'

function providerWith(client: object) {
	const provider = new AnthropicProvider({ apiKey: 'synthetic-key' })
	;(provider as unknown as { client: object }).client = client
	return provider
}

function pageResponse(id: string, hasMore = false) {
	return Response.json({
		data: [
			{ id, display_name: `Account ${id}`, type: 'model', created_at: '2026-10-04T00:00:00Z' },
		],
		has_more: hasMore,
		first_id: id,
		last_id: id,
	})
}

describe('strict model catalogue', () => {
	it('preserves actual account rows and the namespace receiver, without adding offline models', async () => {
		const namespace = {
			list: vi.fn(async function (this: object) {
				expect(this).toBe(namespace)
				return { data: [{ id: 'account-model', display_name: 'Account model' }, {}] }
			}),
		}
		const provider = providerWith({ models: namespace })
		const controller = new AbortController()
		expect(await provider.listModelsStrict(controller.signal)).toEqual([
			{
				id: 'account-model',
				name: 'Account model',
				supportsToolUse: true,
				supportsStreaming: true,
			},
		])
		expect(namespace.list).toHaveBeenCalledWith({ limit: 100 }, { signal: controller.signal })
	})

	it('keeps an empty account catalogue empty while preserving the legacy fallback', async () => {
		const provider = providerWith({ models: { list: async () => ({ data: [] }) } })
		expect(await provider.listModelsStrict()).toEqual([])
		expect(await provider.listModels()).toEqual(OFFLINE_MODEL_CATALOGUE)
	})

	it('reads later account rows through real SDK pages with the same caller signal', async () => {
		let calls = 0
		const fetch = vi.fn(async () =>
			++calls === 1 ? pageResponse('first-model', true) : pageResponse('later-model'),
		)
		const client = new Anthropic({ apiKey: 'synthetic-key', fetch, maxRetries: 0 })
		const requests = vi.spyOn(client, 'requestAPIList')
		const controller = new AbortController()
		const catalogue = await providerWith(client).listModelsStrict(controller.signal)
		expect(catalogue.map(({ id, name }) => ({ id, name }))).toEqual([
			{ id: 'first-model', name: 'Account first-model' },
			{ id: 'later-model', name: 'Account later-model' },
		])
		expect(fetch).toHaveBeenCalledTimes(2)
		expect(requests).toHaveBeenCalledTimes(2)
		expect(requests.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({ signal: controller.signal, query: { limit: 100 } }),
		)
		expect(requests.mock.calls[1]?.[1]).toEqual(
			expect.objectContaining({
				signal: controller.signal,
				query: { limit: 100, after_id: 'first-model' },
			}),
		)
	})

	it('preserves cancellation during the next real SDK page without publishing a partial catalogue', async () => {
		let nextStarted!: () => void
		const nextRequest = new Promise<void>((resolve) => {
			nextStarted = resolve
		})
		let calls = 0
		const fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				if (++calls === 1) return pageResponse('first-model', true)
				return new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal
					if (!signal) throw new Error('The next request must retain cancellation.')
					signal.addEventListener('abort', () => reject(signal.reason), { once: true })
					nextStarted()
				})
			},
		)
		const client = new Anthropic({ apiKey: 'synthetic-key', fetch, maxRetries: 0 })
		const requests = vi.spyOn(client, 'requestAPIList')
		const controller = new AbortController()
		const cancellation = new Error('Fixture cancelled during the next page.')
		const operation = providerWith(client).listModelsStrict(controller.signal)
		const rejected = expect(operation).rejects.toBe(cancellation)
		await nextRequest
		controller.abort(cancellation)
		await rejected
		expect(fetch).toHaveBeenCalledTimes(2)
		expect(requests.mock.calls[1]?.[1]).toEqual(
			expect.objectContaining({ signal: controller.signal }),
		)
	})

	it('rejects nonterminating or oversized catalogues instead of returning partial rows', async () => {
		const getNextPage = vi.fn<() => Promise<unknown>>()
		const page = {
			data: [{ id: 'account-model' }],
			hasNextPage: () => true,
			getNextPage,
		}
		getNextPage.mockResolvedValue(page)
		await expect(
			providerWith({ models: { list: async () => page } }).listModelsStrict(),
		).rejects.toThrow('page limit')
		expect(page.getNextPage).toHaveBeenCalledTimes(99)
		const data = Array.from({ length: 10_001 }, (_, index) => ({ id: `account-model-${index}` }))
		await expect(
			providerWith({ models: { list: async () => ({ data }) } }).listModelsStrict(),
		).rejects.toThrow('row limit')
	})

	it.each([401, 503])(
		'preserves the actual %s failure instead of reporting known model availability',
		async (status) => {
			const failure = Object.assign(new Error('Synthetic remote failure.'), { status })
			const provider = providerWith({
				models: {
					list: async () => {
						throw failure
					},
				},
			})
			await expect(provider.listModelsStrict()).rejects.toBe(failure)
			expect(await provider.listModels()).toEqual(OFFLINE_MODEL_CATALOGUE)
		},
	)

	it('refuses missing API support and preserves caller cancellation', async () => {
		await expect(providerWith({}).listModelsStrict()).rejects.toThrow('actual model catalogue')
		const list = vi.fn(async () => ({ data: [] }))
		const provider = providerWith({ models: { list } })
		const controller = new AbortController()
		const cancellation = new Error('Fixture cancelled.')
		controller.abort(cancellation)
		await expect(provider.listModelsStrict(controller.signal)).rejects.toBe(cancellation)
		expect(list).not.toHaveBeenCalled()
	})
})
