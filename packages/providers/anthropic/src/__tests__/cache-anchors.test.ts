import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * A single breakpoint at the conversation tail writes a new cache entry
 * every turn and reads none of them: by the next request the tail has
 * moved, so the marker sits somewhere the previous entry does not cover.
 *
 * The tools and system tiers keep hitting through their own breakpoints,
 * which is what made this invisible — only the messages tier silently
 * re-billed as a write. The second anchor goes one turn back, which is
 * where the previous request put its tail marker, so the next request finds
 * a prefix that is already cached.
 *
 * It matters most where the history grows fastest: pending tool results
 * collapse into one user message, so a fan-out of N parallel calls appends
 * 2N content blocks in a single turn.
 */

function captureBody() {
	const bodies: Record<string, unknown>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			bodies.push(JSON.parse(init.body))
			return { ok: true, body: null, json: async () => ({ content: [] }) } as never
		}),
	)
	return { provider: new AnthropicProvider({ apiKey: 'k' }), bodies }
}

async function send(
	provider: AnthropicProvider,
	messages: unknown[],
	caching = true,
): Promise<void> {
	try {
		for await (const _ of provider.chatStream({
			model: 'test-model',
			messages: messages as never,
			maxTokens: 64,
			...(caching ? { cacheControl: { type: 'ephemeral' as const } } : {}),
		})) {
			// drain
		}
	} catch {
		// The fake response is not a real stream; the body is already captured.
	}
}

interface WireMessage {
	role: string
	content: string | Array<{ cache_control?: unknown }>
}

const markedIndexes = (body: Record<string, unknown>): number[] =>
	(body.messages as WireMessage[])
		.map((m, i) => ({ m, i }))
		.filter(
			({ m }) =>
				typeof m.content !== 'string' && m.content.some((b) => b.cache_control !== undefined),
		)
		.map(({ i }) => i)

describe('conversation anchors', () => {
	it('marks the tail and one turn back', async () => {
		const { provider, bodies } = captureBody()
		await send(provider, [
			{ role: 'user', content: 'one' },
			{ role: 'assistant', content: 'two' },
			{ role: 'user', content: 'three' },
		])

		expect(markedIndexes(bodies[0] as Record<string, unknown>)).toHaveLength(2)
	})

	it('marks only one when there is only one message', async () => {
		const { provider, bodies } = captureBody()
		await send(provider, [{ role: 'user', content: 'only' }])
		expect(markedIndexes(bodies[0] as Record<string, unknown>)).toHaveLength(1)
	})

	it('keeps the prior boundary reachable across a wide fan-out', async () => {
		// Pending tool results collapse into one user message, so ten
		// parallel calls append twenty content blocks in a single turn —
		// which is what pushes the previous tail marker out of reach.
		const calls = Array.from({ length: 10 }, (_, i) => ({
			id: `c${i}`,
			type: 'function' as const,
			function: { name: 't', arguments: '{}' },
		}))

		const { provider, bodies } = captureBody()
		await send(provider, [
			{ role: 'user', content: 'start' },
			{ role: 'assistant', content: 'thinking' },
			{ role: 'user', content: 'go wide' },
			{ role: 'assistant', content: null, toolCalls: calls },
			...calls.map((c) => ({ role: 'tool', toolCallId: c.id, content: 'ok' })),
		])

		const marked = markedIndexes(bodies[0] as Record<string, unknown>)
		expect(marked).toHaveLength(2)
		// Two anchors on different messages — one at the tail, one behind
		// it. Both on the same message would cache nothing extra.
		expect(marked[0]).toBeLessThan(marked[1] as number)
	})

	it('places no conversation anchor when caching was not requested', async () => {
		const { provider, bodies } = captureBody()
		await send(
			provider,
			[
				{ role: 'user', content: 'one' },
				{ role: 'assistant', content: 'two' },
			],
			false,
		)

		expect(JSON.stringify(bodies[0])).not.toContain('cache_control')
	})
})
