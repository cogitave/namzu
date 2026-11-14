/**
 * Three small driver fixes, each against a loopback fake fetch whose requests
 * are counted:
 *
 * 1. A failed request names the upstream host and its code (never `metadata.raw`).
 * 2. Cache writes are read from `prompt_tokens_details.cache_write_tokens`.
 * 3. A thinking budget is fitted under the request's output limit.
 */

import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const MODEL = 'acme/some-model'
const RAW = 'PROMPT-TEXT-ECHOED-BY-MODERATION'

const sse = (frames: unknown[]): string =>
	`${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`

const okFrames = (usage?: unknown): unknown[] => [
	{ id: 'g', choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }], usage },
]

type Reply = { status: number; body: string }

function fake(replies: Reply[]): { chat: Record<string, any>[] } {
	const seen: { chat: Record<string, any>[] } = { chat: [] }
	let i = 0
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: unknown, init?: RequestInit) => {
			if (String(url).endsWith('/models')) return new Response('{}', { status: 404 })
			seen.chat.push(JSON.parse(String(init?.body)))
			const r = replies[Math.min(i++, replies.length - 1)] as Reply
			return new Response(r.body, {
				status: r.status,
				headers: { 'Content-Type': r.status === 200 ? 'text/event-stream' : 'application/json' },
			})
		}),
	)
	return seen
}

function provider(): OpenRouterProvider {
	return new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' })
}

async function collect(params: Partial<ChatCompletionParams> = {}): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const c of provider().chatStream({
		model: MODEL,
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	})) {
		chunks.push(c)
	}
	return chunks
}

async function failure(params: Partial<ChatCompletionParams> = {}): Promise<Error> {
	try {
		await collect(params)
	} catch (err) {
		return err as Error
	}
	throw new Error('expected a failure')
}

describe('an error names the refusing host', () => {
	it('names host and code on an HTTP error and leaves metadata.raw out', async () => {
		const seen = fake([
			{
				status: 400,
				body: JSON.stringify({
					error: {
						message: 'Provider returned error',
						code: 400,
						metadata: { provider_name: 'Acme\u0007Cloud', provider_code: 'bad_param', raw: RAW },
					},
				}),
			},
		])
		const err = await failure()
		expect(err.message).toContain('Acme Cloud')
		expect(err.message).toContain('bad_param')
		expect(err.message).not.toContain(RAW)
		expect(JSON.stringify(err)).not.toContain(RAW)
		expect(seen.chat).toHaveLength(1)
	})

	it('caps a long host name', async () => {
		fake([
			{
				status: 500,
				body: JSON.stringify({
					error: { message: 'x', metadata: { provider_name: 'h'.repeat(500) } },
				}),
			},
		])
		const err = await failure()
		expect(err.message).toContain('h'.repeat(64))
		expect(err.message).not.toContain('h'.repeat(65))
	})

	it('names host and error_type on a mid-stream error chunk', async () => {
		fake([
			{
				status: 200,
				body: sse([
					{
						id: 'g',
						error: {
							message: 'Provider disconnected',
							code: 502,
							metadata: { provider_name: 'AcmeCloud', error_type: 'upstream_reset', raw: RAW },
						},
					},
				]),
			},
		])
		const err = await failure()
		expect(err.message).toContain('AcmeCloud')
		expect(err.message).toContain('upstream_reset')
		expect(err.message).not.toContain(RAW)
	})

	it('keeps a context overflow named only in metadata.raw classified as one (HTTP)', async () => {
		const OVERFLOW = 'This model maximum context length is 8192 tokens'
		fake([
			{
				status: 400,
				body: JSON.stringify({
					error: {
						message: 'Provider returned error',
						code: 400,
						metadata: { provider_name: 'Acme', provider_code: 'x', raw: OVERFLOW },
					},
				}),
			},
		])
		const err = (await failure()) as Error & { kind?: string }
		expect(err.kind).toBe('context_overflow')
		expect(err.message).toContain('Acme')
		expect(err.message).not.toContain(OVERFLOW)
		expect(JSON.stringify(err)).not.toContain(OVERFLOW)
	})

	it('keeps a context overflow named only in metadata.raw classified as one (mid-stream)', async () => {
		const OVERFLOW = 'This model maximum context length is 8192 tokens'
		fake([
			{
				status: 200,
				body: sse([
					{
						id: 'g',
						error: {
							message: 'Provider returned error',
							metadata: { provider_name: 'Acme', error_type: 'x', raw: OVERFLOW },
						},
					},
				]),
			},
		])
		const err = (await failure()) as Error & { kind?: string }
		expect(err.kind).toBe('context_overflow')
		expect(err.message).not.toContain(OVERFLOW)
		expect(JSON.stringify(err)).not.toContain(OVERFLOW)
	})

	it('still sends exactly one more request after a 400 naming tool_choice', async () => {
		const seen = fake([
			{
				status: 400,
				body: JSON.stringify({
					error: {
						message: 'This model does not support this tool_choice',
						metadata: { provider_name: 'AcmeCloud', provider_code: 'x', raw: RAW },
					},
				}),
			},
			{ status: 200, body: sse(okFrames()) },
		])
		const chunks = await collect({ toolChoice: 'required' })
		expect(seen.chat).toHaveLength(2)
		expect(seen.chat[0]).toHaveProperty('tool_choice')
		expect(seen.chat[1]).not.toHaveProperty('tool_choice')
		expect(chunks.length).toBeGreaterThan(0)
	})

	it('classifies a body that is not JSON as before, with no host named', async () => {
		fake([{ status: 502, body: 'upstream gateway exploded' }])
		const err = await failure()
		expect(err.message).not.toMatch(/host /)
		expect((err as { kind?: string }).kind).toBe('server')
	})
})

describe('cache writes', () => {
	const usage = (extra: Record<string, unknown>, details: Record<string, unknown>) => ({
		prompt_tokens: 100,
		completion_tokens: 5,
		total_tokens: 105,
		prompt_tokens_details: details,
		...extra,
	})
	const lastUsage = (chunks: StreamChunk[]) =>
		chunks
			.map((c) => (c as { usage?: any }).usage)
			.filter(Boolean)
			.pop()

	it('reads cache_write_tokens when the other field is absent', async () => {
		fake([
			{
				status: 200,
				body: sse(okFrames(usage({}, { cached_tokens: 10, cache_write_tokens: 40 }))),
			},
		])
		const u = lastUsage(await collect())
		expect(u.cacheWriteTokens).toBe(40)
		expect(u.promptTokens).toBe(100)
		expect(u.cachedTokens).toBe(10)
	})

	it('keeps cache_creation_input_tokens when both are present', async () => {
		fake([
			{
				status: 200,
				body: sse(okFrames(usage({ cache_creation_input_tokens: 7 }, { cache_write_tokens: 40 }))),
			},
		])
		expect(lastUsage(await collect()).cacheWriteTokens).toBe(7)
	})
})

describe('a thinking budget fits under the output limit', () => {
	const sent = async (budgetTokens: number, maxTokens?: number): Promise<unknown> => {
		const seen = fake([{ status: 200, body: sse(okFrames()) }])
		await collect({
			thinking: { type: 'enabled', budgetTokens },
			...(maxTokens !== undefined ? { maxTokens } : {}),
		})
		return seen.chat[0]?.reasoning?.max_tokens
	}

	it('leaves a budget below the limit unchanged', async () => {
		expect(await sent(2000, 8000)).toBe(2000)
	})
	it('reduces a budget at or above the limit to max_tokens - 1', async () => {
		expect(await sent(8000, 8000)).toBe(7999)
		expect(await sent(20000, 8000)).toBe(7999)
	})
	it('raises a budget under 1024 to 1024', async () => {
		expect(await sent(500, 8000)).toBe(1024)
	})
	it('leaves it alone when max_tokens is 1024 or less, or missing', async () => {
		expect(await sent(5000, 1024)).toBe(5000)
		expect(await sent(500, 800)).toBe(500)
		expect(await sent(5000)).toBe(5000)
	})
	it('does not touch an effort-mode request', async () => {
		const seen = fake([{ status: 200, body: sse(okFrames()) }])
		await collect({ effort: 'high', maxTokens: 4000 })
		expect(seen.chat[0]?.reasoning).toEqual({ effort: 'high' })
	})
})
