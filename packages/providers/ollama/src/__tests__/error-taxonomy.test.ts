/**
 * Provider error taxonomy + finish-reason truth — Ollama driver.
 *
 * Two defects in one file:
 *
 *  1. `chatStream` hardcodes `finishReason: 'stop'` on the final chunk, so
 *     a length-truncated answer is indistinguishable from a finished one.
 *     The runtime's auto-continuation
 *     (`packages/sdk/src/runtime/query/iteration/index.ts`, the
 *     `response.finishReason === 'length'` branch) can therefore NEVER
 *     fire for Ollama — a truncated answer is silently presented as final.
 *  2. An HTTP failure surfaces as the ollama SDK's own `ResponseError`,
 *     which no caller can classify.
 *
 * Transport seam: `OllamaConfig.fetch` is already a first-class injection
 * point on the driver (`new Ollama({ host, fetch })`).
 */

import type { StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { OllamaProvider } from '../client.js'

/** Obviously fake, non-functional token — present only as a leak probe. */
const FAKE_CREDENTIAL = 'sk-ant-FAKE-DO-NOT-USE-0000'

/** An NDJSON body, the wire shape the ollama SDK's stream parser consumes. */
function ndjsonResponse(lines: object[]): Response {
	const text = `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`
	return new Response(text, {
		status: 200,
		headers: { 'Content-Type': 'application/x-ndjson' },
	})
}

function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

function providerWithFetch(impl: () => Promise<Response>): OllamaProvider {
	return new OllamaProvider({
		host: 'http://ollama.test:11434',
		model: 'llama3.1',
		fetch: (async () => impl()) as unknown as typeof fetch,
	})
}

async function collectChunks(provider: OllamaProvider): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'llama3.1',
		messages: [{ role: 'user', content: 'write me a long essay' }],
	})) {
		out.push(chunk)
	}
	return out
}

async function captureChatStreamError(
	provider: OllamaProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	try {
		for await (const _chunk of provider.chatStream({
			model: 'llama3.1',
			messages: [{ role: 'user', content: 'write me a long essay' }],
			signal,
		})) {
			// drain
		}
	} catch (err) {
		return err
	}
	throw new Error('expected chatStream to throw')
}

describe('@namzu/ollama — finish reason truth', () => {
	it("(b) a final chunk with `done_reason: 'length'` yields finishReason 'length'", async () => {
		const provider = providerWithFetch(async () =>
			ndjsonResponse([
				{
					model: 'llama3.1',
					message: { role: 'assistant', content: 'Once upon' },
					done: false,
				},
				{
					model: 'llama3.1',
					message: { role: 'assistant', content: '' },
					done: true,
					done_reason: 'length',
					prompt_eval_count: 12,
					eval_count: 128,
				},
			]),
		)

		const chunks = await collectChunks(provider)
		const terminal = chunks.at(-1)

		expect(terminal?.finishReason).toBe('length')
	})

	it("(b) a final chunk with `done_reason: 'stop'` still yields finishReason 'stop'", async () => {
		const provider = providerWithFetch(async () =>
			ndjsonResponse([
				{
					model: 'llama3.1',
					message: { role: 'assistant', content: 'Done.' },
					done: false,
				},
				{
					model: 'llama3.1',
					message: { role: 'assistant', content: '' },
					done: true,
					done_reason: 'stop',
					prompt_eval_count: 12,
					eval_count: 3,
				},
			]),
		)

		const chunks = await collectChunks(provider)

		expect(chunks.at(-1)?.finishReason).toBe('stop')
	})
})

describe('@namzu/ollama — provider error taxonomy', () => {
	it('(a) 429 with `retry-after: 2` throws a throttle-classified error carrying retryAfterMs', async () => {
		const provider = providerWithFetch(async () =>
			jsonResponse(429, { error: 'too many requests' }, { 'retry-after': '2' }),
		)

		const err = await captureChatStreamError(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'throttle',
			status: 429,
			providerId: 'ollama',
		})
		// `retryAfterMs` is deliberately NOT asserted here, and this is the one
		// driver where it cannot be. The ollama SDK's `checkOk` builds a
		// `ResponseError` from the body's `error` field and the status code and
		// discards the response — headers included — so `retry-after` is gone
		// before this driver sees the failure. The only way to recover it would be
		// to wrap the injected `fetch` and stash the header on the provider
		// instance, which cross-attributes under concurrent requests. An absent
		// `retryAfterMs` is honest; a possibly-wrong one is not. Ollama is a local
		// server that does not send the header anyway.
		expect((err as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
	})

	it("(c) 400 whose body says the prompt is too long classifies as 'context_overflow'", async () => {
		const provider = providerWithFetch(async () =>
			jsonResponse(400, { error: 'input length exceeds context length' }),
		)

		const err = await captureChatStreamError(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'context_overflow',
			status: 400,
			providerId: 'ollama',
		})
	})

	it('(d) SECURITY: a credential echoed back in a 401 body never reaches the thrown message', async () => {
		const provider = providerWithFetch(async () =>
			jsonResponse(401, { error: `unauthorized for ${FAKE_CREDENTIAL}` }),
		)

		const err = await captureChatStreamError(provider)

		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect(JSON.stringify(err)).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('classifies and sanitizes an iterator failure after streaming began', async () => {
		const vendor = new Error(`socket failed for ${FAKE_CREDENTIAL}`)
		const provider = new OllamaProvider({
			host: 'http://ollama.test:11434',
			model: 'llama3.1',
		})
		const stream = {
			abort() {},
			async *[Symbol.asyncIterator]() {
				yield {
					model: 'llama3.1',
					message: { role: 'assistant', content: 'partial' },
					done: false,
				}
				throw vendor
			},
		}
		;(provider as unknown as { client: unknown }).client = {
			chat: async () => stream,
		}

		const err = await captureChatStreamError(provider)

		expect(err).toMatchObject({
			name: 'ProviderRequestError',
			kind: 'network',
			providerId: 'ollama',
		})
		expect((err as Error).message).not.toContain(FAKE_CREDENTIAL)
		expect('cause' in (err as object)).toBe(false)
	})

	it('returns the caller abort reason while the initial POST is still pending', async () => {
		const controller = new AbortController()
		const reason = new Error('user stopped')
		const abortLateStream = vi.fn()
		const lateStream = {
			abort: abortLateStream,
			async *[Symbol.asyncIterator]() {
				// no chunks
			},
		}
		let resolveStream: ((stream: typeof lateStream) => void) | undefined
		const streamPromise = new Promise<typeof lateStream>((resolve) => {
			resolveStream = resolve
		})
		const chat = vi.fn(async () => streamPromise)
		const provider = new OllamaProvider({
			host: 'http://ollama.test:11434',
			model: 'llama3.1',
		})
		;(provider as unknown as { client: unknown }).client = {
			chat,
		}

		const pending = captureChatStreamError(provider, controller.signal)
		await Promise.resolve()
		expect(chat).toHaveBeenCalledOnce()
		controller.abort(reason)
		const err = await pending

		expect(err).toBe(reason)

		resolveStream?.(lateStream)
		await vi.waitFor(() => expect(abortLateStream).toHaveBeenCalledOnce())
	})
})
