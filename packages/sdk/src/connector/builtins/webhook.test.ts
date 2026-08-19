/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 5):
 *
 *   - `WebhookConnector.connect` stores config + auth; merges default
 *     headers; sets `Authorization: Bearer <token>` iff auth is
 *     bearer with a token (other auth types are ignored here).
 *   - `disconnect` clears state.
 *   - `healthCheck` HEAD-fetches the configured url; true iff
 *     `ok || status < 500`; false on thrown fetch or empty url.
 *   - `execute("send", input)`:
 *     - Validates input via zod.
 *     - Posts JSON to `input.url ?? config.url`.
 *     - Always sets `Content-Type: application/json`.
 *     - When `config.secret` is set, computes HMAC-SHA256 over the
 *       stringified payload and sets `X-Webhook-Signature: sha256=<hex>`.
 *     - `success: true` iff `status in [200, 300)`; redirects are not followed.
 *     - `metadata.deliveredAt` is a recent timestamp.
 */

import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WebhookConnector } from './webhook.js'

function makeResponse(init: {
	status?: number
	headers?: Record<string, string>
	body?: unknown
}) {
	const headers = new Headers(init.headers ?? { 'content-type': 'application/json' })
	return {
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		statusText: 'OK',
		headers,
		json: async () => init.body,
		text: async () => String(init.body ?? ''),
	}
}

describe('WebhookConnector', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		global.fetch = fetchMock as unknown as typeof fetch
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it.each([0, -1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])(
		'refuses invalid timeout %s at connect',
		async (timeoutMs) => {
			const c = new WebhookConnector()
			await expect(c.connect({ url: 'https://hook.example.com', timeoutMs })).rejects.toThrow(
				/timeoutMs/,
			)
		},
	)

	it.each([0, -1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])(
		'refuses invalid response byte limit %s at connect',
		async (maxResponseBytes) => {
			const c = new WebhookConnector()
			await expect(
				c.connect({ url: 'https://hook.example.com', maxResponseBytes }),
			).rejects.toThrow(/maxResponseBytes/)
		},
	)

	it.each(['file:///tmp/hook', 'ftp://hook.example.com/x'])(
		'refuses non-HTTP webhook URL %s',
		async (url) => {
			const c = new WebhookConnector()
			await expect(c.connect({ url })).rejects.toThrow(/http/)
		},
	)

	it('connect + disconnect round-trip state', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com/x' })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200 }))
		expect(await c.healthCheck()).toBe(true)
		await c.disconnect()
		expect(await c.healthCheck()).toBe(false)
	})

	it('bearer auth sets Authorization header on send', async () => {
		const c = new WebhookConnector()
		await c.connect(
			{ url: 'https://hook.example.com' },
			{ type: 'bearer', credentials: { token: 'tkn' } },
		)
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		await c.execute('send', { payload: {} })
		const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer tkn')
	})

	it.each(['Host', 'hOsT', 'Proxy-Authorization', 'proxy-connection'])(
		'refuses model-authored routing header %s before attaching configured auth',
		async (header) => {
			const c = new WebhookConnector()
			await c.connect(
				{ url: 'https://hook.example.com' },
				{ type: 'bearer', credentials: { token: 'must-not-leave' } },
			)

			await expect(
				c.execute('send', {
					payload: {},
					headers: { [header]: 'evil.internal' },
				}),
			).rejects.toThrow(/cannot set routing header/)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it('send posts JSON to the configured URL', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		await c.execute('send', { payload: { k: 'v' } })
		expect(fetchMock).toHaveBeenCalledWith(
			'https://hook.example.com',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify({ k: 'v' }),
			}),
		)
	})

	it('input.url may override the path on the configured origin', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com/default' })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		await c.execute('send', { payload: {}, url: 'https://hook.example.com/override' })
		expect(fetchMock).toHaveBeenCalledWith(
			'https://hook.example.com/override',
			expect.objectContaining({ redirect: 'manual' }),
		)
	})

	it.each(['https://outside.example/hook', 'ftp://hook.example.com/hook'])(
		'refuses webhook override %s before attaching configured auth or fetching',
		async (url) => {
			const c = new WebhookConnector()
			await c.connect(
				{ url: 'https://hook.example.com/default' },
				{ type: 'bearer', credentials: { token: 'secret' } },
			)

			await expect(c.execute('send', { payload: {}, url })).rejects.toThrow(
				/configured connector origin|http: or https:/,
			)
			expect(fetchMock).not.toHaveBeenCalled()
		},
	)

	it('a pre-aborted send starts no fetch and reports a safe retry', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		const result = await c.execute(
			'send',
			{ payload: {} },
			{ signal: AbortSignal.abort(new Error('stopped before send')) },
		)

		expect(fetchMock).not.toHaveBeenCalled()
		expect(result.metadata).toMatchObject({ remoteOutcome: 'not_started', retrySafety: 'safe' })
	})

	it('bounds a fetch that ignores abort and reports an unsafe unknown delivery outcome', async () => {
		vi.useFakeTimers()
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com', timeoutMs: 5 })
		let transportSignal: AbortSignal | undefined
		fetchMock.mockImplementationOnce(
			(_url, init: RequestInit) =>
				new Promise((resolve) => {
					transportSignal = init.signal as AbortSignal
					setTimeout(
						() => resolve(makeResponse({ status: 202, body: { arrived: 'too late' } })),
						50,
					)
				}),
		)

		const pending = c.execute('send', { payload: { id: 1 } })
		await vi.advanceTimersByTimeAsync(50)
		const result = await pending

		expect(result.metadata).toMatchObject({
			remoteOutcome: 'unknown',
			retrySafety: 'unsafe',
			bodyAvailable: false,
		})
		expect(result.error).toMatch(/do not automatically retry/i)
		expect(transportSignal?.aborted).toBe(true)
	})

	it('preserves a 202 acceptance when the response body never settles', async () => {
		vi.useFakeTimers()
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com', timeoutMs: 5 })
		fetchMock.mockResolvedValueOnce({
			...makeResponse({ status: 202 }),
			json: () =>
				new Promise((resolve) => {
					setTimeout(() => resolve({ arrived: 'too late' }), 50)
				}),
		})

		const pending = c.execute('send', { payload: { id: 1 } })
		await vi.advanceTimersByTimeAsync(50)
		const result = await pending
		const output = result.output as Record<string, unknown>

		expect(result.success).toBe(true)
		expect(output).toMatchObject({
			status: 202,
			bodyAvailable: false,
			remoteOutcome: 'response_received',
			retrySafety: 'unsafe',
		})
	})

	it('shares one deadline between response headers and the body', async () => {
		vi.useFakeTimers()
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com', timeoutMs: 5 })
		fetchMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					setTimeout(
						() =>
							resolve({
								...makeResponse({ status: 202 }),
								json: () =>
									new Promise((resolveBody) => {
										setTimeout(() => resolveBody({ arrived: 'after total deadline' }), 4)
									}),
							}),
						4,
					)
				}),
		)

		const pending = c.execute('send', { payload: { once: true } })
		await vi.advanceTimersByTimeAsync(8)
		const result = await pending

		expect(result.metadata).toMatchObject({
			remoteOutcome: 'response_received',
			bodyAvailable: false,
		})
		expect(result.output).toMatchObject({ body: null, bodyAvailable: false })
	})

	it('cancels a chunked body above its byte limit without losing accepted delivery', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com', maxResponseBytes: 5 })
		let transportSignal: AbortSignal | undefined
		let streamCancelReason: unknown
		fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
			transportSignal = init.signal as AbortSignal
			return Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('1234'))
							controller.enqueue(new TextEncoder().encode('5678'))
							setTimeout(() => {
								try {
									controller.close()
								} catch {
									// The bounded reader already cancelled the source.
								}
							}, 25)
						},
						cancel(reason) {
							streamCancelReason = reason
						},
					}),
					{
						status: 202,
						headers: { 'content-type': 'text/plain', 'content-length': '1' },
					},
				),
			)
		})

		const result = await c.execute('send', { payload: { once: true } })
		const output = result.output as Record<string, unknown>

		expect(result.success).toBe(true)
		expect(result.metadata).toMatchObject({
			remoteOutcome: 'response_received',
			retrySafety: 'unsafe',
			bodyAvailable: false,
		})
		expect(output.bodyError).toMatch(/5-byte limit/)
		expect(streamCancelReason).toMatchObject({ name: 'ResponseSizeError' })
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toMatchObject({ name: 'ResponseSizeError' })
	})

	it('includes HMAC signature when secret is configured', async () => {
		const secret = 's3cret'
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com', secret })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		await c.execute('send', { payload: { k: 'v' } })
		const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
		const expected = `sha256=${createHmac('sha256', secret)
			.update(JSON.stringify({ k: 'v' }))
			.digest('hex')}`
		expect(headers['X-Webhook-Signature']).toBe(expected)
	})

	it('omits HMAC signature when no secret is configured', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		await c.execute('send', { payload: {} })
		const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
		expect(headers['X-Webhook-Signature']).toBeUndefined()
	})

	it('success: true for 2xx; false for 4xx/5xx', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })

		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		expect((await c.execute('send', { payload: {} })).success).toBe(true)

		fetchMock.mockResolvedValueOnce(makeResponse({ status: 500, body: 'err' }))
		expect((await c.execute('send', { payload: {} })).success).toBe(false)
	})

	it('reports a manual redirect as incomplete instead of claiming delivery', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		fetchMock.mockResolvedValueOnce(
			makeResponse({
				status: 302,
				headers: {
					'content-type': 'text/plain',
					location: 'https://outside.example/hook',
				},
				body: '',
			}),
		)

		const result = await c.execute('send', { payload: { once: true } })

		expect(result.success).toBe(false)
		expect(result.metadata).toMatchObject({
			remoteOutcome: 'response_received',
			retrySafety: 'unsafe',
			status: 302,
			redirectLocation: 'https://outside.example/hook',
		})
		expect(result.error).toMatch(/redirect was not followed/i)
		expect(result.error).toContain('https://outside.example/hook')
	})

	it('healthCheck returns false when the HEAD fetch throws', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		fetchMock.mockRejectedValueOnce(new Error('network down'))
		expect(await c.healthCheck()).toBe(false)
	})

	it('stops an in-flight health transport with the caller cause', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		let transportSignal: AbortSignal | undefined
		fetchMock.mockImplementationOnce(
			(_url, init: RequestInit) =>
				new Promise((resolve, reject) => {
					transportSignal = init.signal as AbortSignal
					transportSignal.addEventListener(
						'abort',
						() =>
							reject(Object.assign(new Error('generic transport abort'), { name: 'AbortError' })),
						{ once: true },
					)
					setTimeout(() => resolve(makeResponse({ status: 200 })), 25)
				}),
		)
		const caller = new AbortController()
		const pending = c.healthCheck({ signal: caller.signal })
		const reason = new Error('stop webhook health')
		caller.abort(reason)

		expect(await pending).toBe(false)
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toBe(reason)
	})

	it('reads a text body when the response is not JSON', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		fetchMock.mockResolvedValueOnce(
			makeResponse({
				status: 200,
				headers: { 'content-type': 'text/plain' },
				body: 'plain-text-ack',
			}),
		)
		const result = await c.execute('send', { payload: { k: 'v' } })
		expect((result.output as { body: unknown }).body).toBe('plain-text-ack')
	})

	it('metadata.deliveredAt is a recent timestamp', async () => {
		const before = Date.now()
		const c = new WebhookConnector()
		await c.connect({ url: 'https://hook.example.com' })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		const result = await c.execute('send', { payload: {} })
		const delivered = (result.metadata as { deliveredAt: number }).deliveredAt
		expect(delivered).toBeGreaterThanOrEqual(before)
	})
})
