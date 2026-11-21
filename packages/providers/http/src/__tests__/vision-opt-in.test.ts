import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'
import type { HttpConfig, HttpDialect } from '../types.js'
import { finishedStream } from './finished-stream.js'

/**
 * Pictures are sent only when the endpoint's operator opts in with `vision`
 * (every model, or the named ones), on both dialects. Without it the request
 * is what it always was (vision.test.ts pins that).
 */

const PNG = 'iVBORw0KGgo='

afterEach(() => {
	vi.unstubAllGlobals()
})

async function bodyFor(
	dialect: HttpDialect,
	vision: HttpConfig['vision'],
	messages: unknown[],
	model = 'm',
) {
	let captured: Record<string, unknown> = {}
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			captured = JSON.parse(String(init.body))
			return new Response(finishedStream(dialect), {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			})
		}),
	)
	const provider = new HttpProvider({
		baseURL: 'https://example.test/v1',
		apiKey: 'k',
		dialect,
		...(vision === undefined ? {} : { vision }),
	})
	for await (const _chunk of provider.chatStream({ model, messages } as never)) {
		// drain
	}
	return captured
}

const user = {
	role: 'user',
	content: 'what is this',
	attachments: [{ data: PNG, mediaType: 'image/png' }],
}
const toolTurn = [
	{ role: 'user', content: 'look' },
	{
		role: 'assistant',
		content: '',
		toolCalls: [{ id: 'call_9', type: 'function', function: { name: 'shot', arguments: '{}' } }],
	},
	{
		role: 'tool',
		toolCallId: 'call_9',
		content: [
			{ type: 'text', text: 'done' },
			{ type: 'image', data: PNG, mediaType: 'image/png' },
		],
	},
]

describe('the vision setting', () => {
	it('is off by default and the capabilities say so', () => {
		const p = new HttpProvider({ baseURL: 'https://example.test/v1' })
		expect(p.capabilities.supportsVision).toBe(false)
		expect(p.supportsImageInputFor('m')).toBe(false)
	})

	it('declares pictures once on, and answers per model for a list', () => {
		const all = new HttpProvider({ baseURL: 'https://e.test/v1', vision: true })
		expect(all.capabilities.supportsVision).toBe(true)
		expect(all.capabilities.supportsToolResultImages).toBe(true)
		expect(all.supportsImageInputFor('anything')).toBe(true)
		const some = new HttpProvider({ baseURL: 'https://e.test/v1', vision: ['llava'] })
		expect(some.capabilities.supportsVision).toBe(true)
		expect(some.supportsImageInputFor('llava')).toBe(true)
		expect(some.supportsImageInputFor('llava:13b')).toBe(true)
		expect(some.supportsImageInputFor('qwen')).toBe(false)
		const none = new HttpProvider({ baseURL: 'https://e.test/v1', vision: false })
		expect(none.capabilities.supportsVision).toBe(false)
		const empty = new HttpProvider({ baseURL: 'https://e.test/v1', vision: [] })
		expect(empty.capabilities.supportsVision).toBe(false)
	})
})

describe('openai dialect with vision on', () => {
	it('maps a picture to an image_url data-URL part', async () => {
		const body = await bodyFor('openai', true, [user])
		expect(body.messages).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'what is this' },
					{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
				],
			},
		])
	})

	it('sends no picture to a model outside the list', async () => {
		const body = await bodyFor('openai', ['llava'], [user], 'qwen')
		expect(body.messages).toEqual([{ role: 'user', content: 'what is this' }])
		expect(JSON.stringify(body)).not.toContain('image_url')
	})

	it('sends the picture to a model in the list', async () => {
		const body = await bodyFor('openai', ['llava'], [user], 'llava')
		expect(JSON.stringify(body)).toContain('image_url')
	})

	it('keeps a withheld picture out', async () => {
		const body = await bodyFor('openai', true, [
			{
				...user,
				attachments: [
					{ data: PNG, mediaType: 'image/png', modelOmission: { reason: 'provider-rejected' } },
				],
			},
		])
		expect(body.messages).toEqual([{ role: 'user', content: 'what is this' }])
	})

	it('puts a tool result picture in a user message right after the tool messages, naming the call', async () => {
		const body = await bodyFor('openai', true, toolTurn)
		const sent = body.messages as { role: string; content: unknown }[]
		expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
		expect(sent[2]?.content).toContain('done')
		expect(sent[2]?.content).toContain('shown in the next message')
		expect(sent[3]?.content).toEqual([
			{ type: 'text', text: 'Image returned by tool call call_9:' },
			{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
		])
	})

	it('keeps a tool result picture as a placeholder when vision is off', async () => {
		const body = await bodyFor('openai', undefined, toolTurn)
		const sent = body.messages as { role: string; content: unknown }[]
		expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
		expect(JSON.stringify(body)).not.toContain('image_url')
	})
})

describe('anthropic dialect with vision on', () => {
	it('maps a picture to a base64 image block', async () => {
		const body = await bodyFor('anthropic', true, [user])
		expect(body.messages).toEqual([
			{
				role: 'user',
				content: [
					{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
					{ type: 'text', text: 'what is this' },
				],
			},
		])
	})

	it('carries a tool result picture inside the tool_result', async () => {
		const body = await bodyFor('anthropic', true, toolTurn)
		const last = (body.messages as { content: { type: string; content: unknown }[] }[]).at(-1)
		expect(last?.content[0]?.type).toBe('tool_result')
		expect(last?.content[0]?.content).toEqual([
			{ type: 'text', text: 'done' },
			{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
		])
	})

	it('sends no picture to a model outside the list', async () => {
		const body = await bodyFor('anthropic', ['claude-x'], [user], 'other')
		expect(JSON.stringify(body)).not.toContain('"image"')
	})
})
