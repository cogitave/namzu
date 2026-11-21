/**
 * The upstream caches by prefix. A request for the next user message must
 * start with exactly the messages of the request before it, reasoning
 * included; an earlier assistant message re-sent without the reasoning it
 * carried the time before moves the prefix and bills the history again.
 */

import type { AssistantMessage, ChatCompletionParams, Message, ProviderRoute } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const MODEL = 'anthropic/claude-haiku-5.5'
const ROUTE: ProviderRoute = { providerId: 'openrouter', model: MODEL, chainIndex: 0 }

function stub(): { bodies: Record<string, any>[] } {
	const bodies: Record<string, any>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)))
			const frame = JSON.stringify({
				id: 'gen-1',
				choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }],
			})
			return new Response(`data: ${frame}\n\ndata: [DONE]\n\n`, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		}),
	)
	return { bodies }
}

async function send(
	messages: Message[],
	extra: Partial<ChatCompletionParams> = {},
): Promise<Record<string, any>> {
	const { bodies } = stub()
	const p = new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' })
	const chunks: unknown[] = []
	for await (const chunk of p.chatStream({ model: MODEL, messages, ...extra })) chunks.push(chunk)
	return bodies[0] as Record<string, any>
}

function step(n: number, over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: 'assistant',
		content: null,
		toolCalls: [{ id: `call_${n}`, type: 'function', function: { name: 'read', arguments: '{}' } }],
		reasoning: [{ type: 'thinking', text: `thought ${n}` }],
		source: {
			type: 'model',
			...ROUTE,
			replayState: {
				kind: 'namzu-openrouter-reasoning',
				version: 1,
				route: ROUTE,
				details: [{ type: 'reasoning.text', text: `thought ${n}`, format: 'unknown', index: 0 }],
			},
		},
		...over,
	} as AssistantMessage
}

const user = (content: string): Message => ({ role: 'user', content }) as Message
const result = (n: number): Message =>
	({ role: 'tool', toolCallId: `call_${n}`, content: `out ${n}` }) as Message

/**
 * Sets the breakpoint aside, which moves by design to the newest message: the
 * marker itself, and the one-part array a marked string is wrapped in.
 */
function withoutMarkers(messages: unknown[]): unknown[] {
	const plain = JSON.parse(
		JSON.stringify(messages, (k, v) => (k === 'cache_control' ? undefined : v)),
	) as { content?: unknown }[]
	return plain.map((m) => {
		const c = m.content
		const only = Array.isArray(c) && c.length === 1 ? c[0] : undefined
		return only && only.type === 'text' ? { ...m, content: only.text } : m
	})
}

describe('the next request starts with the messages of the one before', () => {
	const turn1: Message[] = [
		{ role: 'system', content: 'sys', cacheHint: 'cache' } as Message,
		user('first'),
		step(1),
		result(1),
		step(2),
		result(2),
	]
	const turn2: Message[] = [...turn1, user('second'), step(3), result(3)]

	it('keeps every earlier message byte for byte when a user message arrives', async () => {
		const before = await send(turn1)
		const after = await send(turn2)
		expect(JSON.stringify(after.messages.slice(0, before.messages.length))).toBe(
			JSON.stringify(before.messages),
		)
		expect(after.messages[2].reasoning_details).toHaveLength(1)
		expect(after.messages[4].reasoning_details).toHaveLength(1)
	})

	it('holds with explicit breakpoints once the marker is set aside', async () => {
		const cache = { cacheControl: { type: 'auto' } } as Partial<ChatCompletionParams>
		const before = await send(turn1, cache)
		const after = await send(turn2, cache)
		expect(withoutMarkers(after.messages.slice(0, before.messages.length))).toEqual(
			withoutMarkers(before.messages),
		)
	})

	it('puts the breakpoint on the last sent message when an entry before it is left out', async () => {
		const empty = { role: 'assistant', content: null, toolCalls: [] } as unknown as Message
		const [sys, ...rest] = turn1
		const body = await send([sys as Message, empty, ...rest], {
			cacheControl: { type: 'auto' },
		} as Partial<ChatCompletionParams>)
		expect(body.messages).toHaveLength(turn1.length)
		const marked = body.messages
			.map((m: unknown, i: number) => (JSON.stringify(m).includes('cache_control') ? i : -1))
			.filter((i: number) => i > 0)
		expect(marked).toEqual([turn1.length - 1])
	})
})
