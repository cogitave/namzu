/**
 * Provider error taxonomy — OpenRouter driver.
 *
 * Every provider failure must reach the caller as a classified
 * `ProviderRequestError` (kind + status + retryAfterMs + providerId), not
 * as an opaque vendor string. The message must be built from the status
 * line and the classified kind ONLY — never from the response body, which
 * is where a credential echoed back by the upstream would leak into a log.
 *
 * Transport seam: the driver calls the global `fetch` directly, so the
 * existing `vi.stubGlobal('fetch', …)` harness from `http.test.ts` applies
 * verbatim.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'

/**
 * An obviously fake, non-functional token. Present ONLY to prove the
 * driver does not interpolate a response body into a thrown message.
 */
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

async function captureChatStreamError(
	provider: OpenRouterProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'anthropic/claude-sonnet-4-5',
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

function makeProvider(): OpenRouterProvider {
	return new OpenRouterProvider({
		apiKey: 'test-key',
		baseUrl: 'https://example.test/api/v1',
	})
}

describe('@namzu/openrouter — provider error taxonomy', () => {
	it('(a) 429 with `retry-after: 2` throws a throttle-classified error carrying retryAfterMs', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(429, JSON.stringify({ error: { message: 'rate limit exceeded' } }), {
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
			providerId: 'openrouter',
		})
	})

	it("(c) 400 whose body says the prompt is too long classifies as 'context_overflow'", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(
					400,
					JSON.stringify({
						error: {
							type: 'invalid_request_error',
							message: 'prompt is too long: 305231 tokens > 200000 maximum',
						},
					}),
				),
			),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			status: 400,
			providerId: 'openrouter',
		})
	})

	it("(c) 400 that is not an overflow classifies as 'bad_request'", async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(
					400,
					JSON.stringify({
						error: {
							type: 'invalid_request_error',
							message: "unknown field 'temperture'",
						},
					}),
				),
			),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			status: 400,
			providerId: 'openrouter',
		})
	})

	it("(a/auth) 401 classifies as 'auth'", async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					respond(401, JSON.stringify({ error: { message: 'No auth credentials found' } })),
				),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'auth',
			status: 401,
			providerId: 'openrouter',
		})
	})

	it('(d) SECURITY: a credential echoed back in a 401 body never reaches the thrown message', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				respond(
					401,
					JSON.stringify({
						error: { message: `invalid api key: ${FAKE_CREDENTIAL}` },
					}),
				),
			),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toBeInstanceOf(Error)
		const message = (err as Error).message
		expect(message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('(d) SECURITY: a credential echoed back in a 400 body never reaches the thrown message', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					respond(400, `bad request for key ${FAKE_CREDENTIAL}: model not permitted`),
				),
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
			providerId: 'openrouter',
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

	it('classifies and sanitizes an SSE error after the 200 response', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				sseResponse([
					`data: ${JSON.stringify({
						error: {
							type: 'overloaded_error',
							message: `echoed ${FAKE_CREDENTIAL}`,
						},
					})}`,
				]),
			),
		)

		const err = await captureChatStreamError(makeProvider())

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			providerId: 'openrouter',
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
			providerId: 'openrouter',
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})
})
