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
 *     - `success: true` iff status in [200, 300). Manual redirects are
 *       returned as incomplete rather than followed across the configured origin. Metadata includes
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
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	describe('connect + disconnect', () => {
		it.each([0, -1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])(
			'refuses invalid timeout %s at connect',
			async (timeoutMs) => {
				const c = new HttpConnector()
				await expect(c.connect({ baseUrl: 'https://api.example.com', timeoutMs })).rejects.toThrow(
					/timeoutMs/,
				)
			},
		)

		it.each([0, -1, 1.5, 2_147_483_648, Number.POSITIVE_INFINITY])(
			'refuses invalid response byte limit %s at connect',
			async (maxResponseBytes) => {
				const c = new HttpConnector()
				await expect(
					c.connect({ baseUrl: 'https://api.example.com', maxResponseBytes }),
				).rejects.toThrow(/maxResponseBytes/)
			},
		)

		it.each(['file:///tmp/x', 'ftp://api.example.com/x'])(
			'refuses non-HTTP base URL %s',
			async (baseUrl) => {
				const c = new HttpConnector()
				await expect(c.connect({ baseUrl })).rejects.toThrow(/http/)
			},
		)

		it('strips trailing slashes from baseUrl', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com//', timeoutMs: 30_000 })
			// Follow-up request lands on the cleaned URL:
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: { ok: true } }))
			await c.execute('request', { method: 'GET', path: 'x' })
			expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/x', expect.any(Object))
		})

		it('strips trailing slashes in linear time (js/polynomial-redos regression)', async () => {
			// A long run of slashes followed by one more character is the
			// pathological case for a `/+$` regex: the tail never matches, so a
			// backtracking engine retries the quantifier at every start position.
			// This must stay well under the ~500ms the vulnerable regex took at
			// this size (see connect() history) to prove the O(n) fix held.
			const c = new HttpConnector()
			const hostile = `https://api.example.com/${'/'.repeat(30_000)}a`
			const start = Date.now()
			await c.connect({ baseUrl: hostile, timeoutMs: 30_000 })
			expect(Date.now() - start).toBeLessThan(200)
		})

		it('disconnect clears internal state; execute after disconnect treats baseUrl as empty', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', timeoutMs: 30_000 })
			await c.disconnect()
			expect(await c.healthCheck()).toBe(false)
		})
	})

	describe('auth resolution', () => {
		it.each(['Host', 'hOsT', 'Proxy-Authorization', 'proxy-connection'])(
			'refuses model-authored routing header %s before attaching configured auth',
			async (header) => {
				const c = new HttpConnector()
				await c.connect(
					{ baseUrl: 'https://api.example.com' },
					{ type: 'bearer', credentials: { token: 'must-not-leave' } },
				)

				await expect(
					c.execute('request', {
						method: 'GET',
						path: '/resource',
						headers: { [header]: 'evil.internal' },
					}),
				).rejects.toThrow(/cannot set routing header/)
				expect(fetchMock).not.toHaveBeenCalled()
			},
		)

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

		it('none / custom add no auth headers', async () => {
			// `oauth2` was in this list, and that is what the defect was: it
			// meant a connector configured for OAuth2 reached the upstream with
			// no credential at all. `none` and `custom` belong here — the first
			// asks for no auth, the second says the host attaches its own.
			for (const type of ['none', 'custom'] as const) {
				const c = new HttpConnector()
				await c.connect({ baseUrl: 'https://api.example.com' }, { type, credentials: {} })
				fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))
				await c.execute('request', { method: 'GET', path: 'x' })
				const headers = fetchMock.mock.calls.at(-1)?.[1].headers as Record<string, string>
				expect(headers.Authorization).toBeUndefined()
				expect(headers['X-API-Key']).toBeUndefined()
			}
		})

		it('oauth2 refuses rather than reaching the upstream unauthenticated', async () => {
			const c = new HttpConnector()

			await expect(
				c.connect({ baseUrl: 'https://api.example.com' }, { type: 'oauth2', credentials: {} }),
			).rejects.toThrow(/accessToken/)
		})

		it('oauth2 sends the access token it was given', async () => {
			const c = new HttpConnector()
			await c.connect(
				{ baseUrl: 'https://api.example.com' },
				{ type: 'oauth2', credentials: { accessToken: 'tok_1' } },
			)
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: {} }))

			await c.execute('request', { method: 'GET', path: 'x' })

			const headers = fetchMock.mock.calls.at(-1)?.[1].headers as Record<string, string>
			expect(headers.Authorization).toBe('Bearer tok_1')
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

		it('settles and aborts a non-cooperative health transport when the caller stops', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			let transportSignal: AbortSignal | undefined
			fetchMock.mockImplementationOnce(
				(_url, init: RequestInit) =>
					new Promise(() => {
						transportSignal = init.signal as AbortSignal
					}),
			)
			const caller = new AbortController()
			const pending = c.healthCheck({ signal: caller.signal })
			const reason = new Error('health cancelled')
			caller.abort(reason)

			expect(await pending).toBe(false)
			expect(transportSignal).not.toBe(caller.signal)
			expect(transportSignal?.aborted).toBe(true)
			expect(transportSignal?.reason).toBe(reason)
		})
	})

	describe('execute', () => {
		it.each(['https://outside.example/path', '//outside.example/path', '\\\\outside.example/path'])(
			'refuses cross-origin path %s before attaching credentials or fetching',
			async (path) => {
				const c = new HttpConnector()
				await c.connect(
					{ baseUrl: 'https://api.example.com' },
					{ type: 'bearer', credentials: { token: 'secret' } },
				)

				await expect(c.execute('request', { method: 'GET', path })).rejects.toThrow(
					/configured connector origin/,
				)
				expect(fetchMock).not.toHaveBeenCalled()
			},
		)

		it('allows a same-origin absolute path and disables automatic redirects', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com/base' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 302, body: '' }))

			await c.execute('request', {
				method: 'GET',
				path: 'https://api.example.com/other',
			})

			expect(fetchMock).toHaveBeenCalledWith(
				'https://api.example.com/other',
				expect.objectContaining({ redirect: 'manual' }),
			)
		})

		it('a pre-aborted operation starts no fetch and reports a safe retry', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			const reason = new Error('stopped before request')
			const signal = AbortSignal.abort(reason)

			const result = await c.execute('request', { method: 'POST', path: 'thing' }, { signal })

			expect(fetchMock).not.toHaveBeenCalled()
			expect(result.success).toBe(false)
			expect(result.metadata).toMatchObject({
				remoteOutcome: 'not_started',
				retrySafety: 'safe',
			})
		})

		it('bounds a fetch that ignores its signal and reports an unsafe unknown POST outcome', async () => {
			vi.useFakeTimers()
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', timeoutMs: 5 })
			let transportSignal: AbortSignal | undefined
			fetchMock.mockImplementationOnce(
				(_url, init: RequestInit) =>
					new Promise((resolve) => {
						transportSignal = init.signal as AbortSignal
						setTimeout(
							() => resolve(makeResponse({ status: 200, body: { arrived: 'too late' } })),
							50,
						)
					}),
			)

			const pending = c.execute('request', { method: 'POST', path: 'thing', body: { a: 1 } })
			await vi.advanceTimersByTimeAsync(50)
			const result = await pending

			expect(result.metadata).toMatchObject({
				remoteOutcome: 'unknown',
				retrySafety: 'unsafe',
				bodyAvailable: false,
			})
			expect(result.error).toMatch(/do not automatically retry/i)
			expect(transportSignal?.aborted).toBe(true)
			expect(transportSignal?.reason).toMatchObject({ name: 'TimeoutError' })
		})

		it('keeps a received 202 when its body never settles and marks retry unsafe', async () => {
			vi.useFakeTimers()
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', timeoutMs: 5 })
			fetchMock.mockResolvedValueOnce({
				...makeResponse({ status: 202, statusText: 'Accepted' }),
				json: () =>
					new Promise((resolve) => {
						setTimeout(() => resolve({ arrived: 'too late' }), 50)
					}),
			})

			const pending = c.execute('request', { method: 'POST', path: 'jobs', body: { a: 1 } })
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
			expect(result.metadata).toMatchObject({
				status: 202,
				bodyAvailable: false,
				remoteOutcome: 'response_received',
				retrySafety: 'unsafe',
			})
		})

		it('shares one deadline between response headers and the body', async () => {
			vi.useFakeTimers()
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', timeoutMs: 5 })
			fetchMock.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						setTimeout(
							() =>
								resolve({
									...makeResponse({ status: 200 }),
									json: () =>
										new Promise((resolveBody) => {
											setTimeout(() => resolveBody({ arrived: 'after total deadline' }), 4)
										}),
								}),
							4,
						)
					}),
			)

			const pending = c.execute('request', { method: 'GET', path: 'slow-parts' })
			await vi.advanceTimersByTimeAsync(8)
			const result = await pending

			expect(result.metadata).toMatchObject({
				remoteOutcome: 'response_received',
				bodyAvailable: false,
			})
			expect(result.output).toMatchObject({ body: null, bodyAvailable: false })
		})

		it('cancels a chunked body above its byte limit without losing the received response', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', maxResponseBytes: 5 })
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
							status: 200,
							headers: { 'content-type': 'text/plain', 'content-length': '1' },
						},
					),
				)
			})

			const result = await c.execute('request', { method: 'GET', path: 'chunked' })
			const output = result.output as Record<string, unknown>

			expect(result.success).toBe(true)
			expect(result.metadata).toMatchObject({
				remoteOutcome: 'response_received',
				retrySafety: 'safe',
				bodyAvailable: false,
			})
			expect(output.bodyError).toMatch(/5-byte limit/)
			expect(streamCancelReason).toMatchObject({ name: 'ResponseSizeError' })
			expect(transportSignal?.aborted).toBe(true)
			expect(transportSignal?.reason).toMatchObject({ name: 'ResponseSizeError' })
		})

		it('accepts a response body exactly at the configured byte limit', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com', maxResponseBytes: 5 })
			let transportSignal: AbortSignal | undefined
			fetchMock.mockImplementationOnce((_url, init: RequestInit) => {
				transportSignal = init.signal as AbortSignal
				return Promise.resolve(
					new Response('12345', {
						status: 200,
						headers: { 'content-type': 'text/plain' },
					}),
				)
			})

			const result = await c.execute('request', { method: 'GET', path: 'exact-limit' })

			expect(result.metadata).toMatchObject({ bodyAvailable: true })
			expect(result.output).toMatchObject({ body: '12345', bodyAvailable: true })
			expect(transportSignal?.aborted).toBe(false)
		})

		it('returns success:true for a 2xx response', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(makeResponse({ status: 200, body: { ok: 1 } }))
			const result = await c.execute('request', { method: 'GET', path: 'thing' })
			expect(result.success).toBe(true)
			expect(result.output).toMatchObject({ status: 200 })
		})

		it('reports a manual redirect as incomplete instead of claiming success', async () => {
			const c = new HttpConnector()
			await c.connect({ baseUrl: 'https://api.example.com' })
			fetchMock.mockResolvedValueOnce(
				makeResponse({
					status: 302,
					statusText: 'Found',
					headers: {
						'content-type': 'text/plain',
						location: 'https://outside.example/next',
					},
					body: '',
				}),
			)

			const result = await c.execute('request', { method: 'GET', path: 'redirect' })

			expect(result.success).toBe(false)
			expect(result.metadata).toMatchObject({
				remoteOutcome: 'response_received',
				retrySafety: 'safe',
				status: 302,
			})
			expect(result.error).toMatch(/redirect was not followed/i)
			expect(result.error).toContain('https://outside.example/next')
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
