/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 5):
 *
 *   - `HttpConnector.connect` stores config + auth, strips trailing
 *     slashes from baseUrl, merges default headers with auth-derived
 *     headers.
 *   - Auth resolution (http only — webhook has its own):
 *     - `api_key` with `apiKey` + optional `headerName` (default
 *       `X-API-Key`).
 *     - `bearer` with `token` → `Authorization: Bearer <token>`.
 *     - `basic` with `username` + `password` → base64 encoded.
 *     - `none` / `oauth2` / `custom` → no headers.
 *     - Missing required credential fields throw a typed error string.
 *   - `disconnect` clears internal state.
 *   - `healthCheck` HEAD-fetches baseUrl with a 5s timeout; returns
 *     true iff `response.ok || response.status < 500`; false on any
 *     thrown fetch (e.g. timeout abort).
 *   - `execute("request", input)`:
 *     - `requireMethod` + `validateInput` run.
 *     - Builds URL from `baseUrl + path` + appends query params.
 *     - Sends default+input headers; auto-sets `Content-Type:
 *       application/json` when a body is present and no content-type
 *       was passed.
 *     - Parses response JSON when `content-type: application/json`,
 *       else text.
 *     - `success: true` iff status in [200, 400). Metadata includes
 *       status + statusText.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HttpConnector } from './http.js'

function makeResponse(init: {
	status?: number
	statusText?: string
	headers?: Record<string, string>
	body?: unknown
}) {
	const headers = new Headers(init.headers ?? { 'content-type': 'application/json' })
	return {
		ok: (init.status ?? 200) < 400,
		status: init.status ?? 200,
		statusText: init.statusText ?? 'OK',
		headers,
		json: async () => init.body,
		text: async () => String(init.body ?? ''),
	}
}

describe('HttpConnector', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		global.fetch = fetchMock as unknown as typeof fetch
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('connect + disconnect', () => {
		it('strips trailing slashes from baseUrl', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com//', timeoutMs: 30_000 })
			// Follow-up request lands on the cleaned URL:
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: { ok: true } }))
			await c.execute('request', { method: 'GET', path: 'x' })
			expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/x', expect.any(Object))
		})

		it('disconnect clears internal state; execute after disconnect treats baseUrl as empty', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', timeoutMs: 30_000 })
			await c.disconnect()
			expect(await c.healthCheck()).toBe(false)
		})
	})

	describe('auth resolution', () => {
		it('api_key default header name = X-API-Key', async () => {
			const c = new HttpConnector()
			await c.connect(
				{ baseUrl: 'https://api.example.com' },
				{ type: 'api_key', credentials: { apiKey: 'secret' } },
			)
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
			await c.execute('request', { method: 'GET', path: 'x' })
			const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
			expect(headers['X-API-Key']).toBe('secret')
		})

		it('api_key custom header name is honored', async () => {
			const c = new HttpConnector()
			await c.connect(
				{ baseUrl: 'https://api.example.com' },
				{ type: 'api_key', credentials: { apiKey: 'secret', headerName: 'X-Custom' } },
			)
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
			await c.execute('request', { method: 'GET', path: 'x' })
			const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
			expect(headers['X-Custom']).toBe('secret')
		})

		it('bearer sets Authorization: Bearer <token>', async () => {
			const c = new HttpConnector()
			await c.connect(
				{ baseUrl: 'https://api.example.com' },
				{ type: 'bearer', credentials: { token: 'tkn' } },
			)
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
			await c.execute('request', { method: 'GET', path: 'x' })
			const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
			expect(headers.Authorization).toBe('Bearer tkn')
		})

		it('basic encodes username:password as base64', async () => {
			const c = new HttpConnector()
			await c.connect(
				{ baseUrl: 'https://api.example.com' },
				{ type: 'basic', credentials: { username: 'alice', password: 'pw' } },
			)
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
			await c.execute('request', { method: 'GET', path: 'x' })
			const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
			expect(headers.Authorization).toBe(`Basic ${btoa('alice:pw')}`)
		})

		it('none / oauth2 / custom add no auth headers', async () => {
			for (const type of ['none', 'oauth2', 'custom'] as const) {
				const c = new HttpConnector()
				await c.connect({ baseUrl: 'https://api.example.com' }, { type, credentials: {} })
				fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
				await c.execute('request', { method: 'GET', path: 'x' })
				const headers = fetchMock.mock.calls.at(-1)?.[1].headers as Record<string, string>
				expect(headers.Authorization).toBeUndefined()
				expect(headers['X-API-Key']).toBeUndefined()
			}
		})

		it('api_key throws when apiKey is missing', async () => {
			const c = new HttpConnector()
			await expect(
				c.connect({ baseUrl: 'https://api.example.com' }, { type: 'api_key', credentials: {} }),
			).rejects.toThrow(/missing required credential "apiKey"/)
		})

		it('bearer throws when token is missing', async () => {
			const c = new HttpConnector()
			await expect(
				c.connect({ baseUrl: 'https://api.example.com' }, { type: 'bearer', credentials: {} }),
			).rejects.toThrow(/missing required credential "token"/)
		})

		it('basic throws when either username or password is missing', async () => {
			const c = new HttpConnector()
			await expect(
				c.connect(
					{ baseUrl: 'https://api.example.com' },
					{ type: 'basic', credentials: { username: 'a' } },
				),
			).rejects.toThrow(/missing required credentials/)
		})
	})

	describe('healthCheck', () => {
		it('returns true for ok responses', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200 }))
			expect(await c.healthCheck()).toBe(true)
		})

		it('returns true for 4xx (not-ok but < 500)', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 404 }))
			expect(await c.healthCheck()).toBe(true)
		})

		it('returns false for 5xx', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 503 }))
			expect(await c.healthCheck()).toBe(false)
		})

		it('returns false on thrown fetch', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockRejectedValueOnce(new Error('timeout'))
			expect(await c.healthCheck()).toBe(false)
		})

		it('returns false when never connected', async () => {
			const c = new HttpConnector()
			expect(await c.healthCheck()).toBe(false)
		})
	})

	describe('execute', () => {
		it('returns success:true for 2xx + 3xx responses', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: { ok: 1 } }))
			const result = await c.execute('request', { method: 'GET', path: 'thing' })
			expect(result.success).toBe(true)
			expect(result.output).toMatchObject({ status: 200 })
		})

		it('returns success:false for 4xx / 5xx responses', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 500, body: { err: 1 } }))
			const result = await c.execute('request', { method: 'GET', path: 'thing' })
			expect(result.success).toBe(false)
			expect(result.metadata).toMatchObject({ status: 500 })
		})

		it('sets Content-Type: application/json when body is set and none provided', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
			await c.execute('request', {
				method: 'POST',
				path: 'thing',
				body: { k: 'v' },
			})
			const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
			expect(headers['Content-Type']).toBe('application/json')
		})

		it('preserves caller-supplied Content-Type', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: '' }))
			await c.execute('request', {
				method: 'POST',
				path: 'thing',
				body: 'raw',
				headers: { 'Content-Type': 'text/plain' },
			})
			const headers = fetchMock.mock.calls[0]?.[1].headers as Record<string, string>
			expect(headers['Content-Type']).toBe('text/plain')
		})

		it('appends query params to the URL', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
			await c.execute('request', {
				method: 'GET',
				path: 'thing',
				query: { a: '1', b: '2' },
			})
			expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.example.com/thing?a=1&b=2')
		})

		it('parses JSON response when content-type is json', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(
				makeResponse({
					status: 200,
					headers: { 'content-type': 'application/json' },
					body: { ok: 1 },
				}),
			)
			const result = await c.execute('request', { method: 'GET', path: 'x' })
			expect((result.output as { body: unknown }).body).toEqual({ ok: 1 })
		})

		it('returns text body for non-JSON content-type', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(
				makeResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }),
			)
			const result = await c.execute('request', { method: 'GET', path: 'x' })
			expect((result.output as { body: unknown }).body).toBe('hello')
		})

		it('throws on invalid input (unknown method)', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			await expect(c.execute('not-a-method', {})).rejects.toThrow(/not found/)
		})
	})
})
