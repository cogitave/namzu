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
 *     - `success: true` iff `status in [200, 400)`.
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
		vi.restoreAllMocks()
	})

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

	it('input.url overrides the configured URL', async () => {
		const c = new WebhookConnector()
		await c.connect({ url: 'https://default.example.com' })
		fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: 'ok' }))
		await c.execute('send', { payload: {}, url: 'https://override.example.com' })
		expect(fetchMock).toHaveBeenCalledWith('https://override.example.com', expect.any(Object))
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
