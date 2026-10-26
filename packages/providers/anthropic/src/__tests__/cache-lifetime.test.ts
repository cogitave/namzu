import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The cache lifetime is asked for per request and confirmed by the response.
 * One lifetime goes on every breakpoint (a longer one may not follow a shorter
 * one in the render order), and the lifetime the usage reports is the one the
 * service wrote, not merely the one requested.
 */

type Marker = { type: string; ttl?: string }
type Block = { cache_control?: Marker }

function providerWith(events: unknown[], promptCacheTtl?: '5m' | '1h') {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = new AnthropicProvider({
		apiKey: 'test-key',
		...(promptCacheTtl ? { promptCacheTtl } : {}),
	})
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: {
			create: vi.fn(async (body: Record<string, unknown>) => {
				seen.body = body
				return (async function* () {
					for (const event of events) yield event
				})()
			}),
		},
	}
	return { provider, seen }
}

const PARAMS = {
	model: 'm',
	messages: [
		{
			role: 'system' as const,
			content: 'static rules',
			cacheHint: 'cache' as const,
		},
		{ role: 'user' as const, content: 'hi' },
	],
	tools: [
		{
			type: 'function' as const,
			function: {
				name: 'look',
				description: 'd',
				parameters: { type: 'object', properties: {} },
			},
		},
	],
}

async function run(
	provider: AnthropicProvider,
	extra: Partial<ChatCompletionParams>,
): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		...PARAMS,
		...extra,
	} as ChatCompletionParams)) {
		out.push(chunk)
	}
	return out
}

function markers(body: Record<string, unknown> | undefined): Marker[] {
	const found: Marker[] = []
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item)
			return
		}
		if (value && typeof value === 'object') {
			const block = value as Block
			if (block.cache_control) found.push(block.cache_control)
			for (const child of Object.values(value)) walk(child)
		}
	}
	walk(body)
	return found
}

const START = (usage: Record<string, unknown>) => ({
	type: 'message_start',
	message: { id: 'msg_1', usage },
})

describe('prompt cache lifetime', () => {
	it('puts the one-hour lifetime on every breakpoint when the call asks for it', async () => {
		const { provider, seen } = providerWith([START({ input_tokens: 1 })])
		await run(provider, { cacheControl: { type: 'auto', ttl: '1h' } })
		const found = markers(seen.body)
		expect(found.length).toBe(3)
		expect(found.every((m) => m.type === 'ephemeral' && m.ttl === '1h')).toBe(true)
	})

	it('takes the configured lifetime when the call does not choose one', async () => {
		const { provider, seen } = providerWith([START({ input_tokens: 1 })], '1h')
		await run(provider, { cacheControl: { type: 'auto' } })
		expect(markers(seen.body).every((m) => m.ttl === '1h')).toBe(true)
	})

	it('sends the unchanged marker by default', async () => {
		const { provider, seen } = providerWith([START({ input_tokens: 1 })])
		await run(provider, { cacheControl: { type: 'auto' } })
		expect(markers(seen.body)).toEqual([
			{ type: 'ephemeral' },
			{ type: 'ephemeral' },
			{ type: 'ephemeral' },
		])
	})

	it('reports the lifetime of the bucket the service wrote', async () => {
		const { provider } = providerWith([
			START({
				input_tokens: 1,
				cache_creation_input_tokens: 40,
				cache_creation: {
					ephemeral_5m_input_tokens: 0,
					ephemeral_1h_input_tokens: 40,
				},
			}),
		])
		const chunks = await run(provider, {
			cacheControl: { type: 'auto', ttl: '1h' },
		})
		const usage = chunks.find((c) => c.usage)?.usage
		expect(usage?.cacheTtlMs).toBe(3_600_000)
		expect(usage?.cacheWriteTtlTokens).toEqual({ oneHour: 40 })
	})

	it('reports the shorter lifetime when the service wrote a five-minute entry although one hour was asked', async () => {
		const { provider } = providerWith([
			START({
				cache_creation_input_tokens: 40,
				cache_creation: {
					ephemeral_5m_input_tokens: 40,
					ephemeral_1h_input_tokens: 0,
				},
			}),
		])
		const chunks = await run(provider, {
			cacheControl: { type: 'auto', ttl: '1h' },
		})
		expect(chunks.find((c) => c.usage)?.usage?.cacheTtlMs).toBe(300_000)
	})

	it('falls back to the requested lifetime when the response has no breakdown', async () => {
		const { provider } = providerWith([START({ cache_read_input_tokens: 90 })])
		const chunks = await run(provider, {
			cacheControl: { type: 'auto', ttl: '1h' },
		})
		expect(chunks.find((c) => c.usage)?.usage?.cacheTtlMs).toBe(3_600_000)
	})

	it('claims no lifetime for a call that does not cache', async () => {
		const { provider } = providerWith([START({ input_tokens: 5 })])
		const chunks = await run(provider, {})
		expect(chunks.find((c) => c.usage)?.usage?.cacheTtlMs).toBeUndefined()
	})
})
