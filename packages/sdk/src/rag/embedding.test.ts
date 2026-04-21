/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `OpenRouterEmbeddingProvider`:
 *     - Defaults: dimensions = 1536; baseUrl = openrouter.ai/api/v1;
 *       batchSize = 64.
 *     - `embed(texts)` batches into `batchSize` slices and concatenates
 *       results in input order.
 *     - Each HTTP call posts `{model, input, dimensions}` to
 *       `${baseUrl}/embeddings` with the Bearer authorization header.
 *     - The API response is sorted by `index` ascending before extracting
 *       `.embedding`, so results match input order even if the server
 *       re-orders.
 *     - `embedQuery(query)` returns the first result from `embed([query])`;
 *       throws when the response is empty.
 *     - `!response.ok` → throws with `Embedding API error (<status>): <body>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterEmbeddingProvider } from './embedding.js'

describe('OpenRouterEmbeddingProvider', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		global.fetch = fetchMock as unknown as typeof fetch
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('carries model / dimensions defaults + batchSize', () => {
		const p = new OpenRouterEmbeddingProvider({ apiKey: 'k', model: 'm' })
		expect(p.model).toBe('m')
		expect(p.dimensions).toBe(1536)
	})

	it('honors overrides for dimensions + baseUrl + batchSize', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
		})
		const p = new OpenRouterEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			dimensions: 256,
			baseUrl: 'https://custom.example/api',
		})
		await p.embed(['x'])

		expect(fetchMock).toHaveBeenCalledWith(
			'https://custom.example/api/embeddings',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({
					Authorization: 'Bearer k',
					'Content-Type': 'application/json',
				}),
			}),
		)
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body)
		expect(body).toEqual({ model: 'm', input: ['x'], dimensions: 256 })
		expect(p.dimensions).toBe(256)
	})

	it('batches into batchSize slices', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{ index: 0, embedding: [1] },
					{ index: 1, embedding: [2] },
				],
			}),
		})
		const p = new OpenRouterEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			batchSize: 2,
		})
		await p.embed(['a', 'b', 'c', 'd'])
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('sorts response by index before extracting embeddings', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({
				data: [
					{ index: 2, embedding: [3] },
					{ index: 0, embedding: [1] },
					{ index: 1, embedding: [2] },
				],
			}),
		})
		const p = new OpenRouterEmbeddingProvider({ apiKey: 'k', model: 'm' })
		expect(await p.embed(['a', 'b', 'c'])).toEqual([[1], [2], [3]])
	})

	it('embedQuery returns the first result', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ index: 0, embedding: [9, 9] }] }),
		})
		const p = new OpenRouterEmbeddingProvider({ apiKey: 'k', model: 'm' })
		expect(await p.embedQuery('hi')).toEqual([9, 9])
	})

	it('embedQuery throws when the response is empty', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ data: [] }),
		})
		const p = new OpenRouterEmbeddingProvider({ apiKey: 'k', model: 'm' })
		await expect(p.embedQuery('hi')).rejects.toThrow(/no results/)
	})

	it('throws on non-OK HTTP response', async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 503,
			text: async () => 'service unavailable',
		})
		const p = new OpenRouterEmbeddingProvider({ apiKey: 'k', model: 'm' })
		await expect(p.embed(['hi'])).rejects.toThrow(/503.*service unavailable/)
	})
})
