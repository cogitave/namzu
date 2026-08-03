import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * Where the cache breakpoints land decides what the next iteration pays.
 *
 * Two anchors, and they do different jobs. The SYSTEM anchor sits on the
 * last block the prompt builder tagged `'cache'`, so tools plus the static
 * system prefix are cached and the per-run dynamic segment behind it is
 * not. The MESSAGE anchor sits on the last block of the last non-empty
 * message, so the whole conversation prefix is cached for an iteration
 * that only appends.
 *
 * Both are invisible when wrong: a breakpoint one block too early caches
 * less than it could, one too late caches a segment that changes every run
 * and is never read back. Neither shows up as a failure — only as a bill.
 */

function bodyCapturer(): {
	provider: AnthropicProvider
	seen: { body?: Record<string, unknown> }
} {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = new AnthropicProvider({ apiKey: 'test-key' })
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async (body: Record<string, unknown>) => {
				seen.body = body
				return (async function* () {
					yield { type: 'message_start', message: { id: 'msg_1' } }
				})()
			}),
		},
	}
	return { provider, seen }
}

async function bodyFor(params: Partial<ChatCompletionParams>): Promise<Record<string, unknown>> {
	const { provider, seen } = bodyCapturer()
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
		// Anchors are placed only when the caller asked for caching.
		cacheControl: { type: 'ephemeral' },
		...params,
	} as ChatCompletionParams)) {
		// drain
	}
	return seen.body ?? {}
}

type Block = { type: string; text?: string; cache_control?: { type: string } }

function systemBlocks(body: Record<string, unknown>): Block[] {
	return (body.system ?? []) as Block[]
}

function messageBlocks(body: Record<string, unknown>): Block[] {
	const messages = body.messages as Array<{ content: string | Block[] }>
	const last = messages.at(-1)?.content
	return Array.isArray(last) ? last : []
}

const TAGGED_SYSTEM = [
	{ role: 'system' as const, content: 'static rules', cacheHint: 'cache' as const },
	{ role: 'system' as const, content: 'run-specific context', cacheHint: 'ephemeral' as const },
	{ role: 'user' as const, content: 'go' },
]

describe('the system anchor sits at the end of the cacheable prefix', () => {
	it('marks the last cache-tagged block, not the last block', async () => {
		const body = await bodyFor({
			messages: TAGGED_SYSTEM as unknown as ChatCompletionParams['messages'],
		})
		const blocks = systemBlocks(body)

		expect(blocks[0]).toMatchObject({ text: 'static rules' })
		expect(blocks[0]?.cache_control).toEqual({ type: 'ephemeral' })
		// The dynamic segment changes every run, so caching it writes an
		// entry nothing ever reads back.
		expect(blocks[1]?.cache_control).toBeUndefined()
	})

	it('marks the later of two cache-tagged blocks', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'system', content: 'first', cacheHint: 'cache' },
				{ role: 'system', content: 'second', cacheHint: 'cache' },
				{ role: 'user', content: 'go' },
			] as unknown as ChatCompletionParams['messages'],
		})
		const blocks = systemBlocks(body)

		expect(blocks[0]?.cache_control).toBeUndefined()
		expect(blocks[1]?.cache_control).toEqual({ type: 'ephemeral' })
	})

	it('anchors nothing when no block was tagged for caching', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'system', content: 'untagged' },
				{ role: 'user', content: 'go' },
			] as unknown as ChatCompletionParams['messages'],
		})

		expect(systemBlocks(body).some((b) => b.cache_control)).toBe(false)
	})

	it('keeps one block per system message, so the boundaries survive', async () => {
		const body = await bodyFor({
			messages: TAGGED_SYSTEM as unknown as ChatCompletionParams['messages'],
		})

		expect(systemBlocks(body).map((b) => b.text)).toEqual(['static rules', 'run-specific context'])
	})

	it('sends no system field at all when there are no system messages', async () => {
		const body = await bodyFor({
			messages: [{ role: 'user', content: 'go' }] as ChatCompletionParams['messages'],
		})

		expect(body.system).toBeUndefined()
	})
})

describe('the message anchor sits at the end of the conversation prefix', () => {
	it('promotes a trailing string message to a block so it can carry one', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'second' },
			] as ChatCompletionParams['messages'],
		})

		expect(messageBlocks(body).at(-1)).toMatchObject({
			type: 'text',
			text: 'second',
			cache_control: { type: 'ephemeral' },
		})
	})

	it('marks the last block of an already-blocked message', async () => {
		const body = await bodyFor({
			messages: [
				{
					role: 'user',
					content: 'look',
					attachments: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }],
				},
			] as unknown as ChatCompletionParams['messages'],
		})
		const blocks = messageBlocks(body)

		expect(blocks.at(-1)?.type).toBe('image')
		expect(blocks.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
		expect(blocks[0]?.cache_control).toBeUndefined()
	})

	it('skips an empty trailing message and anchors the one before it', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'real content' },
				{ role: 'assistant', content: '' },
			] as ChatCompletionParams['messages'],
		})
		const messages = body.messages as Array<{ content: string | Block[] }>
		const anchored = messages.filter(
			(m) => Array.isArray(m.content) && m.content.some((b) => b.cache_control),
		)

		// An empty message has no block to hold the anchor, so anchoring it
		// would drop the breakpoint entirely.
		expect(anchored).toHaveLength(1)
		expect((anchored[0]?.content as Block[])[0]?.text).toBe('real content')
	})

	it('places exactly one message anchor', async () => {
		const body = await bodyFor({
			messages: [
				{ role: 'user', content: 'a' },
				{ role: 'assistant', content: 'b' },
				{ role: 'user', content: 'c' },
			] as ChatCompletionParams['messages'],
		})
		const messages = body.messages as Array<{ content: string | Block[] }>
		const anchors = messages
			.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
			.filter((b) => b.cache_control)

		expect(anchors).toHaveLength(1)
	})
})

describe('cache usage is read back off the wire', () => {
	it('reports reads and writes separately, not folded into prompt tokens', async () => {
		const { provider } = bodyCapturer()
		;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
			messages: {
				create: vi.fn(async () =>
					(async function* () {
						yield {
							type: 'message_start',
							message: {
								id: 'msg_1',
								usage: {
									input_tokens: 10,
									output_tokens: 2,
									cache_read_input_tokens: 900,
									cache_creation_input_tokens: 40,
								},
							},
						}
					})(),
				),
			},
		}

		const chunks = []
		for await (const chunk of provider.chatStream({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
		} as ChatCompletionParams)) {
			chunks.push(chunk)
		}

		// The two are priced differently, so folding either into
		// promptTokens would misreport what the run actually cost.
		expect(chunks[0]?.usage).toMatchObject({
			promptTokens: 10,
			cachedTokens: 900,
			cacheWriteTokens: 40,
		})
	})

	it('reads absent cache counters as zero rather than undefined', async () => {
		const { provider } = bodyCapturer()
		;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
			messages: {
				create: vi.fn(async () =>
					(async function* () {
						yield {
							type: 'message_start',
							message: { id: 'm', usage: { input_tokens: 5, output_tokens: 1 } },
						}
					})(),
				),
			},
		}

		const chunks = []
		for await (const chunk of provider.chatStream({
			model: 'm',
			messages: [{ role: 'user', content: 'hi' }],
		} as ChatCompletionParams)) {
			chunks.push(chunk)
		}

		expect(chunks[0]?.usage).toMatchObject({ cachedTokens: 0, cacheWriteTokens: 0 })
	})
})
