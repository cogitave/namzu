/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 4):
 *
 *   - `HttpEmbeddingProvider`:
 *     - Defaults: dimensions = 1536; batchSize = 64; requestTimeoutMs =
 *       30 seconds. The endpoint is always caller-supplied.
 *     - `embed(texts)` batches into `batchSize` slices and concatenates
 *       results in input order.
 *     - Each HTTP call posts `{model, input, dimensions}` to
 *       `${baseUrl}/embeddings` with the Bearer authorization header.
 *     - The API response must contain exactly one unique in-range index per
 *       input and a finite vector of the configured dimension at each index.
 *     - `embedQuery(query)` returns the first result from `embed([query])`;
 *       throws when the response is empty.
 *     - `!response.ok` → throws with `Embedding API error (<status>): <body>`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS, HttpEmbeddingProvider } from './embedding.js'

describe('HttpEmbeddingProvider', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		global.fetch = fetchMock as unknown as typeof fetch
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('carries model / dimensions defaults + batchSize', () => {
		const p = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
		})
		expect(p.model).toBe('m')
		expect(p.dimensions).toBe(1536)
		expect(DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS).toBe(30_000)
	})

	it('honors overrides for dimensions + baseUrl + batchSize', async () => {
		const embedding = Array.from({ length: 256 }, (_, index) => index)
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ index: 0, embedding }] }),
		})
		const p = new HttpEmbeddingProvider({
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
		const p = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			batchSize: 2,
			dimensions: 1,
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
		const p = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			dimensions: 1,
		})
		expect(await p.embed(['a', 'b', 'c'])).toEqual([[1], [2], [3]])
	})

	it('embedQuery returns the first result', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ index: 0, embedding: [9, 9] }] }),
		})
		const p = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			dimensions: 2,
		})
		expect(await p.embedQuery('hi')).toEqual([9, 9])
	})

	it('embedQuery refuses an incomplete response', async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ data: [] }),
		})
		const p = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
		})
		await expect(p.embedQuery('hi')).rejects.toThrow(/0 vectors for 1 inputs/)
	})

	it('throws on non-OK HTTP response', async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 503,
			text: async () => 'service unavailable',
		})
		const p = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
		})
		await expect(p.embed(['hi'])).rejects.toThrow(/503.*service unavailable/)
	})

	it.each([
		{ label: 'the default', configured: undefined, expected: 30_000 },
		{ label: 'an override', configured: 25, expected: 25 },
	])('bounds $label across the whole HTTP operation', async ({ configured, expected }) => {
		vi.useFakeTimers()
		let transportSignal: AbortSignal | undefined
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise(() => {
					transportSignal = init.signal as AbortSignal
				}),
		)

		const provider = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			...(configured === undefined ? {} : { requestTimeoutMs: configured }),
		})
		const pending = provider.embed(['stalled'])
		const observed = pending.catch((error: unknown) => error)

		await vi.advanceTimersByTimeAsync(expected - 1)
		expect(transportSignal?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)

		const error = await Promise.race([observed, Promise.resolve({ pending: true })])
		expect(error).toMatchObject({
			name: 'TimeoutError',
			message: `Embedding request timed out after ${expected}ms`,
		})
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(error)
	})

	it('keeps the deadline armed while the response body is read', async () => {
		vi.useFakeTimers()
		let transportSignal: AbortSignal | undefined
		fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
			transportSignal = init.signal as AbortSignal
			return {
				ok: true,
				json: () =>
					new Promise((_resolve, reject) => {
						transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), {
							once: true,
						})
					}),
			}
		})

		const pending = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			requestTimeoutMs: 10,
		}).embed(['body stalls'])
		const observed = pending.catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(10)

		expect(await Promise.race([observed, Promise.resolve({ pending: true })])).toMatchObject({
			name: 'TimeoutError',
		})
		expect(transportSignal?.aborted).toBe(true)
	})

	it('lets a caller explicitly keep the former unbounded transport', async () => {
		vi.useFakeTimers()
		let transportSignal: AbortSignal | undefined
		let finish: ((value: unknown) => void) | undefined
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((resolve) => {
					transportSignal = init.signal as AbortSignal
					finish = resolve
				}),
		)
		const provider = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			requestTimeoutMs: 0,
			dimensions: 1,
		})

		const pending = provider.embed(['unbounded'])
		await vi.advanceTimersByTimeAsync(DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS * 2)
		expect(transportSignal?.aborted).toBe(false)
		finish?.({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [7] }] }) })
		expect(await pending).toEqual([[7]])
	})

	it.each([-1, 1.5, Number.NaN, 2_147_483_648])(
		'refuses invalid requestTimeoutMs %s before any HTTP work',
		(requestTimeoutMs) => {
			expect(
				() =>
					new HttpEmbeddingProvider({
						apiKey: 'k',
						model: 'm',
						baseUrl: 'https://embeddings.test/v1',
						requestTimeoutMs,
					}),
			).toThrow(/requestTimeoutMs must be an integer/)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it.each([0, -1, 1.5, Number.NaN])(
		'refuses batchSize %s instead of entering a non-progressing batch loop',
		(batchSize) => {
			expect(
				() =>
					new HttpEmbeddingProvider({
						apiKey: 'k',
						model: 'm',
						baseUrl: 'https://embeddings.test/v1',
						batchSize,
					}),
			).toThrow(/batchSize must be a positive safe integer/)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it.each([0, -1, 1.5, Number.NaN])('refuses dimensions %s before any HTTP work', (dimensions) => {
		expect(
			() =>
				new HttpEmbeddingProvider({
					apiKey: 'k',
					model: 'm',
					baseUrl: 'https://embeddings.test/v1',
					dimensions,
				}),
		).toThrow(/dimensions must be a positive safe integer/)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it.each([
		{
			label: 'a non-array data field',
			body: { data: null },
			error: /must contain a data array/,
		},
		{
			label: 'a missing result',
			body: { data: [{ index: 0, embedding: [1] }] },
			error: /1 vectors for 2 inputs/,
		},
		{
			label: 'a duplicate index',
			body: {
				data: [
					{ index: 0, embedding: [1] },
					{ index: 0, embedding: [2] },
				],
			},
			error: /duplicate index 0/,
		},
		{
			label: 'an out-of-range index',
			body: {
				data: [
					{ index: 0, embedding: [1] },
					{ index: 2, embedding: [2] },
				],
			},
			error: /index 2 is outside/,
		},
		{
			label: 'a fractional index',
			body: {
				data: [
					{ index: 0, embedding: [1] },
					{ index: 1.5, embedding: [2] },
				],
			},
			error: /non-integer index/,
		},
		{
			label: 'a dimension mismatch',
			body: {
				data: [
					{ index: 0, embedding: [1] },
					{ index: 1, embedding: [2, 3] },
				],
			},
			error: /must contain 1 finite numbers/,
		},
		{
			label: 'a non-finite coordinate',
			body: {
				data: [
					{ index: 0, embedding: [1] },
					{ index: 1, embedding: [Number.NaN] },
				],
			},
			error: /must contain 1 finite numbers/,
		},
	])('refuses $label instead of returning partial vectors', async ({ body, error }) => {
		fetchMock.mockResolvedValue({ ok: true, json: async () => body })
		const provider = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			dimensions: 1,
		})

		await expect(provider.embed(['a', 'b'])).rejects.toThrow(error)
	})

	it('refuses a pre-aborted operation before even an empty-input no-op', async () => {
		const controller = new AbortController()
		const reason = new Error('operator already stopped retrieval')
		controller.abort(reason)
		const provider = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
		})

		await expect(provider.embed([], { signal: controller.signal })).rejects.toBe(reason)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('preserves caller cancellation and aborts only its owned transport', async () => {
		const caller = new AbortController()
		let transportSignal: AbortSignal | undefined
		fetchMock.mockImplementation(
			(_url: string, init: RequestInit) =>
				new Promise((_resolve, reject) => {
					transportSignal = init.signal as AbortSignal
					transportSignal.addEventListener(
						'abort',
						() => reject(Object.assign(new Error('generic fetch abort'), { name: 'AbortError' })),
						{ once: true },
					)
				}),
		)
		const provider = new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://embeddings.test/v1',
			requestTimeoutMs: 60_000,
			dimensions: 1,
		})
		const pending = provider.embedQuery('cancel me', { signal: caller.signal })
		const reason = new Error('operator stopped the run')

		caller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(caller.signal.reason).toBe(reason)
		expect(transportSignal?.reason).toBe(reason)
		expect(transportSignal).not.toBe(caller.signal)
	})
})

describe('the endpoint is the caller\u2019s decision', () => {
	it('appends the path to whatever root the caller named', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ index: 0, embedding: [1] }] }),
		})
		global.fetch = fetchMock as unknown as typeof fetch

		await new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://vectors.internal/v2',
			dimensions: 1,
		}).embed(['x'])

		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://vectors.internal/v2/embeddings')
	})

	it('tolerates a trailing slash instead of building a double one', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ data: [{ index: 0, embedding: [1] }] }),
		})
		global.fetch = fetchMock as unknown as typeof fetch

		await new HttpEmbeddingProvider({
			apiKey: 'k',
			model: 'm',
			baseUrl: 'https://vectors.internal/v2/',
			dimensions: 1,
		}).embed(['x'])

		expect(fetchMock.mock.calls[0]?.[0]).toBe('https://vectors.internal/v2/embeddings')
	})
})
