import { type ChatCompletionParams, type Message, collectChatCompletion } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZenProvider } from '../client.js'

/**
 * The runtime asks for caching on every request. On the Messages protocol a
 * request-level cache option becomes a top-level `cache_control` —
 * Anthropic's automatic caching, which puts its breakpoint on the last
 * cacheable block. With request-only context (runtime-context messages of
 * kind `step-context`) at the tail, that block is the context the next
 * request replaces, so the history cached under it was never read again.
 * The driver places block-level breakpoints instead, and these tests read
 * them off the HTTP body the native adapter actually sends.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

type Block = { type: string; text?: string; cache_control?: unknown }
type Body = {
	cache_control?: unknown
	system?: Block[]
	messages: { role: string; content: Block[] }[]
}

async function bodyFor(params: Partial<ChatCompletionParams>): Promise<Body> {
	let body: Body | undefined
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(String(init?.body))
			return new Response('{"type":"error","error":{"type":"invalid_request_error"}}', {
				status: 400,
				headers: { 'content-type': 'application/json' },
			})
		}),
	)
	const provider = new ZenProvider({ apiKey: 'k', sessionId: 's' }, 'zen')
	await collectChatCompletion(
		provider.chatStream({
			model: 'claude-haiku-4-5',
			maxTokens: 256,
			cacheControl: { type: 'auto' },
			messages: [],
			...params,
		} as ChatCompletionParams),
	).catch(() => undefined)
	if (!body) throw new Error('no request was sent')
	return body
}

const context = (content: string): Message =>
	({
		role: 'user',
		content,
		source: { type: 'runtime-context', kind: 'step-context' },
	}) as Message

const HISTORY: Message[] = [
	{ role: 'system', content: 'static', cacheHint: 'cache' },
	{ role: 'system', content: 'per-run', cacheHint: 'ephemeral' },
	{ role: 'user', content: 'go' },
	{ role: 'assistant', content: 'working' },
	{ role: 'user', content: 'more' },
]

const MARK = { type: 'ephemeral' }
const marks = (body: Body) => JSON.stringify(body).split('"cache_control"').length - 1

describe('Zen Messages cache breakpoints', () => {
	it('sends no top-level cache_control, whose breakpoint would land on the context', async () => {
		const body = await bodyFor({ messages: [...HISTORY, context('PIN')] })
		expect(body.cache_control).toBeUndefined()
	})

	it('ends the history before request-only context and marks the static system text', async () => {
		const body = await bodyFor({ messages: [...HISTORY, context('PIN'), context('SNAPSHOT')] })
		expect(body.system?.[0]).toMatchObject({ text: 'static', cache_control: MARK })
		expect(body.system?.[1]?.cache_control).toBeUndefined()
		const last = body.messages[body.messages.length - 1]?.content ?? []
		const texts = last.map((block) => block.text)
		expect(texts).toEqual(['more', 'PIN', 'SNAPSHOT'])
		expect(last[0]?.cache_control).toEqual(MARK)
		expect(last[1]?.cache_control).toBeUndefined()
		expect(last[2]?.cache_control).toBeUndefined()
		expect(marks(body)).toBe(2)
	})

	it('keeps the marked prefix identical when only the context changes', async () => {
		const prefix = (body: Body) => {
			const last = body.messages[body.messages.length - 1]?.content ?? []
			return JSON.stringify([body.system, body.messages.slice(0, -1), last[0]])
		}
		const one = await bodyFor({ messages: [...HISTORY, context('PIN ONE')] })
		const two = await bodyFor({ messages: [...HISTORY, context('PIN TWO')] })
		expect(prefix(one)).toBe(prefix(two))
	})

	it('marks the last message when there is no request-only context', async () => {
		const body = await bodyFor({ messages: HISTORY })
		const last = body.messages[body.messages.length - 1]?.content ?? []
		expect(last[last.length - 1]).toMatchObject({ text: 'more', cache_control: MARK })
	})

	it('sends no breakpoint when caching was not requested', async () => {
		const body = await bodyFor({ cacheControl: undefined, messages: [...HISTORY, context('PIN')] })
		expect(marks(body)).toBe(0)
	})
})
