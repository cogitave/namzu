/**
 * Provider error taxonomy — generic HTTP driver (both dialects).
 *
 * `chatStream`'s `!response.ok` branch interpolates the whole response
 * body into the thrown message, which is the most likely place an
 * upstream-echoed credential lands in a log. The failure must instead be
 * a classified `ProviderRequestError` built from the status line and the
 * classified kind ONLY.
 *
 * Transport seam: the driver calls the global `fetch` directly — the
 * `vi.stubGlobal('fetch', …)` harness already used by `http.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpProvider } from '../client.js'
import { DialectMismatchError, type HttpDialect } from '../types.js'

/** Obviously fake, non-functional token — present only as a leak probe. */
const FAKE_CREDENTIAL = 'sk-ant-FAKE-DO-NOT-USE-0000'

afterEach(() => {
	vi.unstubAllGlobals()
})

function respond(status: number, body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

function sseResponse(frames: string[]): Response {
	return new Response(`${frames.join('\n\n')}\n\n`, {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	})
}

function makeProvider(dialect: HttpDialect = 'openai'): HttpProvider {
	return new HttpProvider({
		baseURL: 'https://example.test/v1',
		apiKey: 'test-key',
		dialect,
	})
}

async function captureChatStreamError(
	provider: HttpProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
			signal,
		})) {
			// drain
		}
	} catch (err) {
		return err
	}
	throw new Error('expected chatStream to throw')
}

describe('@namzu/http — provider error taxonomy', () => {
	it('(a) 429 with `retry-after: 2` throws a throttle-classified error carrying retryAfterMs', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(429, JSON.stringify({ error: { message: 'slow down' } }), {
					'retry-after': '2',
				}),
			),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			retryAfterMs: 2000,
			providerId: 'http',
		})
	})

	it("(c) 400 whose body says the prompt is too long classifies as 'context_overflow'", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(
					400,
					JSON.stringify({
						type: 'error',
						error: {
							type: 'invalid_request_error',
							message: 'prompt is too long',
						},
					}),
				),
			),
		)

		const err = await captureChatStreamError(makeProvider('anthropic'))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			status: 400,
			providerId: 'http',
		})
	})

	it("(c) 400 that is not an overflow classifies as 'bad_request'", async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					respond(400, JSON.stringify({ error: { message: 'messages: field required' } })),
				),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			status: 400,
			providerId: 'http',
		})
	})

	it("529 (upstream overload) classifies as 'server'", async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					respond(529, JSON.stringify({ type: 'overloaded_error', message: 'Overloaded' })),
				),
		)

		const err = await captureChatStreamError(makeProvider('anthropic'))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			status: 529,
			providerId: 'http',
		})
	})

	it('(d) SECURITY: a credential echoed back in a 401 body never reaches the thrown message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(
					401,
					JSON.stringify({
						error: { message: `bad x-api-key ${FAKE_CREDENTIAL}` },
					}),
				),
			),
		)

		const err = await captureChatStreamError(makeProvider('anthropic'))

		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('(d) SECURITY: a credential echoed back in a 400 body never reaches the thrown message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(respond(400, `rejected token ${FAKE_CREDENTIAL}`)),
		)

		const err = await captureChatStreamError(makeProvider())

		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
	})

	it("classifies a fetch rejection as 'network' without retaining its cause", async () => {
		const vendor = new Error(`socket failed for ${FAKE_CREDENTIAL}`)
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(vendor))

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'network',
			providerId: 'http',
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('preserves the caller abort reason when fetch replaces the error object', async () => {
		const controller = new AbortController()
		const reason = new Error('user stopped')
		const fetchAbort = Object.assign(new Error('request aborted'), {
			name: 'AbortError',
		})
		controller.abort(reason)
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(fetchAbort))

		const err = await captureChatStreamError(makeProvider(), controller.signal)

		expect(fetchAbort).not.toBe(reason)
		expect(err).toBe(reason)
	})

	it('classifies and sanitizes an Anthropic SSE error after the 200 response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse([
					`event: error\ndata: ${JSON.stringify({
						type: 'error',
						error: {
							type: 'overloaded_error',
							message: `echoed ${FAKE_CREDENTIAL}`,
						},
					})}`,
				]),
			),
		)

		const err = await captureChatStreamError(makeProvider('anthropic'))

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			providerId: 'http',
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('classifies malformed SSE without retaining the credential-bearing frame', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(sseResponse([`data: ${FAKE_CREDENTIAL} not-json`])),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			providerId: 'http',
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('redacts query strings and response samples from dialect mismatch diagnostics', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse([
					`data: ${JSON.stringify({
						type: 'message_start',
						echo: FAKE_CREDENTIAL,
					})}`,
				]),
			),
		)
		const provider = new HttpProvider({
			baseURL: `https://example.test/v1?api_key=${FAKE_CREDENTIAL}`,
			dialect: 'openai',
		})

		const err = await captureChatStreamError(provider)

		expect(err).toBeInstanceOf(DialectMismatchError)
		expect(err).toMatchObject({
			url: 'https://example.test',
			sample: '[redacted]',
			status: 200,
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
	})
})
