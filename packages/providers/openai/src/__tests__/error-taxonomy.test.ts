/**
 * Provider error taxonomy — OpenAI driver.
 *
 * Like the Anthropic driver, this one lets the vendor SDK's own error type
 * escape verbatim (`RateLimitError`, `BadRequestError`, …). Those carry a
 * status but are vendor classes, so no caller can classify them without
 * importing `openai` — and their `message` interpolates the response body.
 *
 * Transport seam: `OpenAIConfig.baseURL` — a loopback server answering
 * with a scripted status/headers/body, so the REAL vendor client runs
 * (including its internal retries, which this group must not disturb).
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../client.js'

/** Obviously fake, non-functional token — present only as a leak probe. */
const FAKE_CREDENTIAL = 'sk-ant-FAKE-DO-NOT-USE-0000'

interface ScriptedReply {
	status: number
	body: string
	headers?: Record<string, string>
}

let server: Server | undefined

afterEach(async () => {
	if (server) {
		await new Promise<void>((resolve) => server?.close(() => resolve()))
		server = undefined
	}
})

async function startEndpoint(reply: ScriptedReply): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(reply.status, {
			'Content-Type': 'application/json',
			...(reply.headers ?? {}),
		})
		res.end(reply.body)
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
	const { port } = server.address() as AddressInfo
	return `http://127.0.0.1:${port}/v1`
}

async function captureChatStreamError(reply: ScriptedReply): Promise<unknown> {
	const baseURL = await startEndpoint(reply)
	// maxRetries is deliberately NOT set: this group classifies errors and
	// must leave the vendor SDK's own retry behaviour exactly as it is.
	const provider = new OpenAIProvider({
		apiKey: 'test-key',
		model: 'gpt-4o-mini',
		baseURL,
	})
	try {
		for await (const _chunk of provider.chatStream({
			model: 'gpt-4o-mini',
			messages: [{ role: 'user', content: 'hi' }],
		})) {
			// drain
		}
	} catch (err) {
		return err
	}
	throw new Error('expected chatStream to throw')
}

async function captureProviderError(
	provider: OpenAIProvider,
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

describe('@namzu/openai — provider error taxonomy', () => {
	it('(a) 429 with `retry-after: 2` throws a throttle-classified error carrying retryAfterMs', async () => {
		const err = await captureChatStreamError({
			status: 429,
			headers: { 'retry-after': '2' },
			body: JSON.stringify({
				error: { message: 'Rate limit reached', type: 'rate_limit_error' },
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			retryAfterMs: 2000,
			providerId: 'openai',
		})
	}, 60_000)

	it("(c) 400 whose body reports a context-length overflow classifies as 'context_overflow'", async () => {
		const err = await captureChatStreamError({
			status: 400,
			body: JSON.stringify({
				error: {
					message:
						"This model's maximum context length is 128000 tokens. However, your messages resulted in 190210 tokens.",
					type: 'invalid_request_error',
					code: 'context_length_exceeded',
				},
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			status: 400,
			providerId: 'openai',
		})
	}, 30_000)

	it("(c) 400 that is not an overflow classifies as 'bad_request'", async () => {
		const err = await captureChatStreamError({
			status: 400,
			body: JSON.stringify({
				error: {
					message: "Unrecognized request argument: 'temperture'",
					type: 'invalid_request_error',
				},
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			status: 400,
			providerId: 'openai',
		})
	}, 30_000)

	it("(auth) 401 classifies as 'auth'", async () => {
		const err = await captureChatStreamError({
			status: 401,
			body: JSON.stringify({
				error: {
					message: 'Incorrect API key provided',
					type: 'invalid_request_error',
				},
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'auth',
			status: 401,
			providerId: 'openai',
		})
	}, 30_000)

	it('(d) SECURITY: a credential echoed back in a 401 body never reaches the thrown message', async () => {
		const err = await captureChatStreamError({
			status: 401,
			body: JSON.stringify({
				error: { message: `Incorrect API key provided: ${FAKE_CREDENTIAL}` },
			}),
		})

		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	}, 30_000)

	it('classifies and sanitizes an SDK failure thrown after streaming began', async () => {
		const vendor = Object.assign(new Error(`overloaded_error ${FAKE_CREDENTIAL}`), {
			name: 'APIError',
		})
		const provider = new OpenAIProvider({
			apiKey: 'test-key',
			model: 'gpt-4o-mini',
		})
		const stream = {
			async *[Symbol.asyncIterator]() {
				yield {
					id: 'chatcmpl-1',
					choices: [{ delta: { content: 'partial' }, finish_reason: null }],
					usage: null,
				}
				throw vendor
			},
		}
		;(provider as unknown as { client: unknown }).client = {
			chat: { completions: { create: async () => stream } },
		}

		const err = await captureProviderError(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			providerId: 'openai',
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('preserves the caller abort reason when the SDK replaces the error object', async () => {
		const controller = new AbortController()
		const reason = new Error('user stopped')
		const sdkAbort = Object.assign(new Error('request aborted'), {
			name: 'APIUserAbortError',
		})
		controller.abort(reason)
		const provider = new OpenAIProvider({
			apiKey: 'test-key',
			model: 'gpt-4o-mini',
		})
		;(provider as unknown as { client: unknown }).client = {
			chat: { completions: { create: async () => Promise.reject(sdkAbort) } },
		}

		const err = await captureProviderError(provider, controller.signal)

		expect(sdkAbort).not.toBe(reason)
		expect(err).toBe(reason)
	})
})
