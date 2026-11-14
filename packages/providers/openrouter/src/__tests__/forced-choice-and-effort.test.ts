/**
 * Two requests that used to fail on this route and now succeed.
 *
 * 1. A forced tool choice (`required` or a named function). A real session got
 *    HTTP 400 "Thinking mode does not support this tool_choice" from an
 *    upstream host of a DeepSeek model. The driver now leaves the choice off
 *    where the model refuses it while reasoning, and a request that did carry
 *    one and drew that 400 is sent once more without it.
 * 2. Effort `max` and `ultra`, legal SDK values the driver used to throw on.
 *    They resolve against the levels the model listing names for the model.
 *
 * The fetch is a loopback fake; every request it sees is counted.
 */

import type { ChatCompletionParams, ReasoningEffort, StreamChunk } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const V4 = 'deepseek/deepseek-v4.1-flash-1017'
const OTHER = 'openai/gpt-5-mini'
const VENDOR_400 = JSON.stringify({
	error: { message: 'Thinking mode does not support this tool_choice', code: 400 },
})

const OK_STREAM = `${[
	JSON.stringify({
		id: 'gen-1',
		choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
	}),
]
	.map((f) => `data: ${f}\n\n`)
	.join('')}data: [DONE]\n\n`

type Reply = { status: number; body: string }
const ok = (): Reply => ({ status: 200, body: OK_STREAM })

interface Fake {
	chat: Record<string, any>[]
	listings: number
}

/** Answers chat requests from `replies` in order (the last repeats) and the listing from `listing`. */
function fake(replies: Reply[], listing?: Reply): Fake {
	const seen: Fake = { chat: [], listings: 0 }
	let i = 0
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: unknown, init?: RequestInit) => {
			if (String(url).endsWith('/models')) {
				seen.listings++
				const l = listing ?? { status: 404, body: '{}' }
				return new Response(l.body, { status: l.status })
			}
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

async function collect(
	p: OpenRouterProvider,
	params: Partial<ChatCompletionParams> = {},
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const c of p.chatStream({
		model: V4,
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	})) {
		chunks.push(c)
	}
	return chunks
}

const NAMED = { type: 'function' as const, function: { name: 'echo' } }

describe('a forced choice is not sent where the model refuses it', () => {
	it.each([
		['required', 'required' as const],
		['a named function', NAMED],
	])('leaves %s off a reasoning DeepSeek V4 request', async (_label, toolChoice) => {
		const seen = fake([ok()])
		await collect(provider(), { toolChoice })
		expect(seen.chat).toHaveLength(1)
		expect(seen.chat[0]).not.toHaveProperty('tool_choice')
	})

	it.each(['auto', 'none'] as const)('passes %s through untouched', async (toolChoice) => {
		const seen = fake([ok()])
		await collect(provider(), { toolChoice })
		expect(seen.chat[0]?.tool_choice).toBe(toolChoice)
	})

	it.each([
		['thinking disabled', { thinking: { type: 'disabled' as const } }],
		['effort none', { effort: 'none' as const }],
	])('sends the choice when %s, where the vendor takes it', async (_label, extra) => {
		const seen = fake([ok()])
		await collect(provider(), { toolChoice: 'required', ...extra })
		expect(seen.chat[0]?.tool_choice).toBe('required')
	})

	it('sends the choice for a model nobody is known to refuse it on', async () => {
		const seen = fake([ok()])
		await collect(provider(), { model: OTHER, toolChoice: 'required' })
		expect(seen.chat[0]?.tool_choice).toBe('required')
	})

	it('says so in the debug log', async () => {
		fake([ok()])
		const debug = vi.fn()
		const p = new OpenRouterProvider({
			apiKey: 'k',
			baseUrl: 'https://example.test/api/v1',
			logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
		})
		await collect(p, { toolChoice: 'required' })
		expect(debug).toHaveBeenCalledWith(expect.stringContaining('forced tool_choice not sent'), {
			'namzu.model': V4,
		})
	})
})

describe('a host that answers the forced choice with a 400 costs one more request', () => {
	it('sends exactly one more request without the choice, and the turn completes', async () => {
		const seen = fake([{ status: 400, body: VENDOR_400 }, ok()])
		const chunks = await collect(provider(), { model: OTHER, toolChoice: 'required' })

		expect(seen.chat).toHaveLength(2)
		expect(seen.chat[0]?.tool_choice).toBe('required')
		expect(seen.chat[1]).not.toHaveProperty('tool_choice')
		// Everything else about the request is unchanged.
		const { tool_choice: _a, ...first } = seen.chat[0] as Record<string, unknown>
		expect(seen.chat[1]).toEqual(first)
		expect(chunks.some((c) => c.delta.content === 'done')).toBe(true)
	})

	it('does the same for a named function', async () => {
		const seen = fake([{ status: 400, body: VENDOR_400 }, ok()])
		await collect(provider(), { model: OTHER, toolChoice: NAMED })
		expect(seen.chat).toHaveLength(2)
		expect(seen.chat[1]).not.toHaveProperty('tool_choice')
	})

	it('does not retry a 400 that is about something else', async () => {
		const seen = fake([{ status: 400, body: JSON.stringify({ error: { message: 'bad json' } }) }])
		await expect(collect(provider(), { model: OTHER, toolChoice: 'required' })).rejects.toThrow()
		expect(seen.chat).toHaveLength(1)
	})

	it('does not retry when no forced choice was sent', async () => {
		const seen = fake([{ status: 400, body: VENDOR_400 }])
		await expect(collect(provider(), { model: OTHER, toolChoice: 'auto' })).rejects.toThrow()
		expect(seen.chat).toHaveLength(1)
	})

	it('does not retry again when the second request fails too', async () => {
		const seen = fake([{ status: 400, body: VENDOR_400 }])
		await expect(collect(provider(), { model: OTHER, toolChoice: 'required' })).rejects.toThrow()
		expect(seen.chat).toHaveLength(2)
	})

	it('does not retry a different status', async () => {
		const seen = fake([{ status: 500, body: VENDOR_400 }])
		await expect(collect(provider(), { model: OTHER, toolChoice: 'required' })).rejects.toThrow()
		expect(seen.chat).toHaveLength(1)
	})
})

function listingWith(models: Record<string, readonly string[] | null>): Reply {
	return {
		status: 200,
		body: JSON.stringify({
			data: Object.entries(models).map(([id, levels]) => ({
				id,
				name: id,
				context_length: 1000,
				...(levels ? { reasoning: { supported_efforts: levels } } : {}),
			})),
		}),
	}
}

describe('effort max and ultra resolve against the model listing', () => {
	const v4Levels = ['max', 'high', 'low', 'none']
	const noMax = ['xhigh', 'high', 'medium', 'low', 'none']

	it.each(['max', 'ultra'] as const)('sends max to a model that lists it (%s)', async (effort) => {
		const seen = fake([ok()], listingWith({ [V4]: v4Levels }))
		await collect(provider(), { effort })
		expect(seen.chat[0]?.reasoning).toEqual({ effort: 'max' })
	})

	it.each(['max', 'ultra'] as const)(
		'sends the highest listed level when max is not listed (%s)',
		async (effort) => {
			const seen = fake([ok()], listingWith({ [V4]: noMax }))
			await collect(provider(), { effort })
			expect(seen.chat[0]?.reasoning).toEqual({ effort: 'xhigh' })
		},
	)

	it('never falls to none, and uses the highest of a short list', async () => {
		const seen = fake([ok()], listingWith({ [V4]: ['low', 'none'] }))
		await collect(provider(), { effort: 'max' })
		expect(seen.chat[0]?.reasoning).toEqual({ effort: 'low' })
	})

	it('finds a :tag variant by its base id', async () => {
		const seen = fake([ok()], listingWith({ [V4]: v4Levels }))
		await collect(provider(), { model: `${V4}:batch`, effort: 'max' })
		expect(seen.chat[0]?.reasoning).toEqual({ effort: 'max' })
	})

	it.each([
		['the listing fails', { status: 500, body: 'nope' }],
		['the listing does not name the model', listingWith({ 'other/model': ['max'] })],
		['the model has no level list', listingWith({ [V4]: null })],
	])('sends xhigh, the documented top level, when %s', async (_label, listing) => {
		const seen = fake([ok()], listing)
		await collect(provider(), { effort: 'ultra' })
		expect(seen.chat).toHaveLength(1)
		expect(seen.chat[0]?.reasoning).toEqual({ effort: 'xhigh' })
	})

	it('reads the listing once for several requests', async () => {
		const seen = fake([ok()], listingWith({ [V4]: v4Levels }))
		const p = provider()
		await collect(p, { effort: 'max' })
		await collect(p, { effort: 'max' })
		expect(seen.listings).toBe(1)
		expect(seen.chat).toHaveLength(2)
	})

	it.each<ReasoningEffort>(['none', 'low', 'high', 'xhigh'])(
		'does not read the listing for %s',
		async (effort) => {
			const seen = fake([ok()], listingWith({ [V4]: v4Levels }))
			await collect(provider(), { effort })
			expect(seen.listings).toBe(0)
			expect(seen.chat[0]?.reasoning).toEqual({ effort })
		},
	)
})
