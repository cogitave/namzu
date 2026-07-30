/**
 * Provider error taxonomy — Anthropic driver.
 *
 * The driver hands the request to the vendor SDK and lets whatever the SDK
 * rejects with escape verbatim (`RateLimitError`, `BadRequestError`, …).
 * Those are vendor types: a caller cannot classify them without importing
 * `@anthropic-ai/sdk`, so nothing downstream can distinguish a throttle
 * from a context overflow from a bad request.
 *
 * Transport seam: `AnthropicConfig.baseURL` — the tests point the SDK at a
 * loopback server that answers with a scripted status/headers/body. This
 * exercises the REAL vendor client (including its own internal retries,
 * which this group must not disturb).
 */

import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../client.js'

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

/** Boot a loopback endpoint that answers every request with `reply`. */
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
	return `http://127.0.0.1:${port}`
}

/** Boot a loopback endpoint that streams `frames` as an SSE 200 response. */
async function startSseEndpoint(frames: string[]): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		})
		res.end(`${frames.join('\n\n')}\n\n`)
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
	const { port } = server.address() as AddressInfo
	return `http://127.0.0.1:${port}`
}

async function captureChatStreamError(reply: ScriptedReply): Promise<unknown> {
	const baseURL = await startEndpoint(reply)
	// maxRetries is deliberately NOT set: this group classifies errors and
	// must leave the vendor SDK's own retry behaviour exactly as it is.
	const provider = new AnthropicProvider({
		apiKey: 'test-key',
		model: 'claude-sonnet-4-5-20250929',
		baseURL,
	})
	try {
		for await (const _chunk of provider.chatStream({
			model: 'claude-sonnet-4-5-20250929',
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
	provider: AnthropicProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'claude-sonnet-4-5-20250929',
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

describe('@namzu/anthropic — provider error taxonomy', () => {
	it('(a) 429 with `retry-after: 2` throws a throttle-classified error carrying retryAfterMs', async () => {
		const err = await captureChatStreamError({
			status: 429,
			headers: { 'retry-after': '2' },
			body: JSON.stringify({
				type: 'error',
				error: { type: 'rate_limit_error', message: 'slow' },
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			retryAfterMs: 2000,
			providerId: 'anthropic',
		})
	}, 60_000)

	it("(c) 400 whose body says the prompt is too long classifies as 'context_overflow'", async () => {
		const err = await captureChatStreamError({
			status: 400,
			body: JSON.stringify({
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: 'prompt is too long: 305231 tokens > 200000 maximum',
				},
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			status: 400,
			providerId: 'anthropic',
		})
	}, 30_000)

	it("(c) 400 that is not an overflow classifies as 'bad_request'", async () => {
		const err = await captureChatStreamError({
			status: 400,
			body: JSON.stringify({
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message: 'messages: at least one message required',
				},
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'bad_request',
			status: 400,
			providerId: 'anthropic',
		})
	}, 30_000)

	it("(auth) 401 classifies as 'auth'", async () => {
		const err = await captureChatStreamError({
			status: 401,
			body: JSON.stringify({
				type: 'error',
				error: { type: 'authentication_error', message: 'invalid x-api-key' },
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'auth',
			status: 401,
			providerId: 'anthropic',
		})
	}, 30_000)

	it("529 (upstream overload) classifies as 'server'", async () => {
		const err = await captureChatStreamError({
			status: 529,
			body: JSON.stringify({
				type: 'error',
				error: { type: 'overloaded_error', message: 'Overloaded' },
			}),
		})

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			status: 529,
			providerId: 'anthropic',
		})
	}, 60_000)

	it("MID-STREAM: an `event: error` frame after a 200 classifies as 'server'", async () => {
		// The vendor SDK's SSE reader throws its own `APIError` for an
		// `event: error` frame (core/streaming: `if (sse.event === 'error')`),
		// so the driver's event switch never sees it — the vendor error escapes
		// the driver unclassified, with the frame body interpolated.
		const baseURL = await startSseEndpoint([
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":5,"output_tokens":0}}}',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
			'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		])
		const provider = new AnthropicProvider({
			apiKey: 'test-key',
			model: 'claude-sonnet-4-5-20250929',
			baseURL,
		})

		let caught: unknown
		try {
			for await (const _chunk of provider.chatStream({
				model: 'claude-sonnet-4-5-20250929',
				messages: [{ role: 'user', content: 'hi' }],
			})) {
				// drain
			}
		} catch (err) {
			caught = err
		}

		expect(caught).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'server',
			providerId: 'anthropic',
		})
	}, 30_000)

	it('(d) SECURITY: a credential echoed back in a 401 body never reaches the thrown message', async () => {
		const err = await captureChatStreamError({
			status: 401,
			body: JSON.stringify({
				type: 'error',
				error: {
					type: 'authentication_error',
					message: `invalid x-api-key ${FAKE_CREDENTIAL}`,
				},
			}),
		})

		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	}, 30_000)

	it('preserves the caller abort reason when the SDK replaces the error object', async () => {
		const controller = new AbortController()
		const reason = new Error('user stopped')
		const sdkAbort = Object.assign(new Error('request aborted'), {
			name: 'APIUserAbortError',
		})
		controller.abort(reason)
		const provider = new AnthropicProvider({
			apiKey: 'test-key',
			model: 'claude-sonnet-4-5-20250929',
		})
		;(provider as unknown as { client: unknown }).client = {
			messages: { create: async () => Promise.reject(sdkAbort) },
		}

		const err = await captureProviderError(provider, controller.signal)

		expect(sdkAbort).not.toBe(reason)
		expect(err).toBe(reason)
	})
})
