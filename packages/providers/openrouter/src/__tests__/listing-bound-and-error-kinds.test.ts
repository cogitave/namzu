/**
 * Two edges of the OpenRouter route.
 *
 * 1. The `/models` listing is bounded. A listing that never answers counts as
 *    "no listing" at the bound, so a chat request that waits on it (effort
 *    `max`) still goes out, and a window lookup falls back to the caller's table.
 * 2. HTTP 402, 403 and 404 each reach the caller as their own kind, and none of
 *    them is retried. A 403 is told apart by its body: moderation versus a
 *    refused key.
 *
 * The fetch is a loopback fake; every request it sees is counted. The bound is
 * advanced with a fake clock, never by waiting.
 */

import type { ProviderRequestError } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MODEL_LISTING_TIMEOUT_MS, OpenRouterProvider } from '../client.js'

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

const OK_STREAM = `data: ${JSON.stringify({
	id: 'gen-1',
	choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
})}\n\ndata: [DONE]\n\n`

function provider(): OpenRouterProvider {
	return new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' })
}

/** A listing that never answers and ignores its signal; chat requests are answered and counted. */
function hungListing() {
	const seen = { chat: 0, listings: 0 }
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: unknown) => {
			if (String(url).endsWith('/models')) {
				seen.listings++
				return new Promise<Response>(() => {})
			}
			seen.chat++
			return new Response(OK_STREAM, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		}),
	)
	return seen
}

describe('a models listing that never answers is bounded', () => {
	it('lets a max-effort chat request go out once the bound passes', async () => {
		vi.useFakeTimers()
		const seen = hungListing()
		const run = (async () => {
			const out: string[] = []
			for await (const c of provider().chatStream({
				model: 'deepseek/deepseek-v4.1-flash-1017',
				messages: [{ role: 'user', content: 'hi' }],
				effort: 'max',
			})) {
				if (c.delta.content) out.push(c.delta.content)
			}
			return out
		})()
		await vi.advanceTimersByTimeAsync(MODEL_LISTING_TIMEOUT_MS - 1)
		expect(seen.chat).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(await run).toEqual(['done'])
		expect(seen.listings).toBe(1)
		expect(seen.chat).toBe(1)
	})

	it('answers a window lookup with no window, so the caller falls back', async () => {
		vi.useFakeTimers()
		const seen = hungListing()
		const lookup = provider().resolveContextWindow('openai/gpt-5-mini')
		await vi.advanceTimersByTimeAsync(MODEL_LISTING_TIMEOUT_MS)
		expect(await lookup).toBeUndefined()
		expect(seen.listings).toBe(1)
	})

	it('fails the model picker listing with a timeout instead of hanging', async () => {
		vi.useFakeTimers()
		hungListing()
		const listed = provider().listModels()
		const settled = expect(listed).rejects.toMatchObject({ name: 'TimeoutError' })
		await vi.advanceTimersByTimeAsync(MODEL_LISTING_TIMEOUT_MS)
		await settled
	})

	it('a caller abort still wins over the bound', async () => {
		vi.useFakeTimers()
		hungListing()
		const controller = new AbortController()
		const lookup = provider().resolveContextWindow('openai/gpt-5-mini', controller.signal)
		controller.abort(new Error('stop'))
		expect(await lookup).toBeUndefined()
	})
})

function failWith(status: number, body: unknown, headers: Record<string, string> = {}) {
	const seen = { chat: 0 }
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => {
			seen.chat++
			return new Response(JSON.stringify(body), {
				status,
				headers: { 'Content-Type': 'application/json', ...headers },
			})
		}),
	)
	return seen
}

async function failure(): Promise<ProviderRequestError> {
	try {
		for await (const _ of provider().chatStream({
			model: 'openai/gpt-5-mini',
			messages: [{ role: 'user', content: 'hi' }],
		})) {
			// drain
		}
	} catch (err) {
		return err as ProviderRequestError
	}
	throw new Error('expected chatStream to throw')
}

describe('402, 403 and 404 reach the caller as their own kinds', () => {
	it('a 402 is credits', async () => {
		const seen = failWith(402, { error: { message: 'Insufficient credits', code: 402 } })
		const err = await failure()
		expect(err.kind).toBe('credits')
		expect(err.status).toBe(402)
		expect(seen.chat).toBe(1)
	})

	it('a 403 that names moderation is moderation', async () => {
		const seen = failWith(403, {
			error: {
				message: 'Input flagged by moderation',
				code: 403,
				metadata: { reasons: ['violence'], provider_name: 'openai' },
			},
		})
		const err = await failure()
		expect(err.kind).toBe('moderation')
		expect(seen.chat).toBe(1)
	})

	it('a 403 about the key stays auth', async () => {
		const seen = failWith(403, { error: { message: 'Key limit exceeded or forbidden', code: 403 } })
		const err = await failure()
		expect(err.kind).toBe('auth')
		expect(seen.chat).toBe(1)
	})

	it('a 404 saying no endpoints were found is no_endpoints', async () => {
		const seen = failWith(404, {
			error: { message: 'No endpoints found for openai/gpt-5-mini.', code: 404 },
		})
		const err = await failure()
		expect(err.kind).toBe('no_endpoints')
		expect(seen.chat).toBe(1)
	})

	it('any other 404 stays a bad request', async () => {
		failWith(404, { error: { message: 'Not found', code: 404 } })
		expect((await failure()).kind).toBe('bad_request')
	})
})
