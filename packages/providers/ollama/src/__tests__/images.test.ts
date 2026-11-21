import { afterEach, describe, expect, it, vi } from 'vitest'

import { OLLAMA_CAPABILITIES, OllamaProvider } from '../client.js'

/**
 * A pasted picture reaches a local model that reads pictures, and only that
 * one. The fake server below answers Ollama's `/api/show` (the model's own
 * information) and `/api/chat`, and records every request body.
 */

const PNG = 'iVBORw0KGgo='

interface Recorded {
	show: string[]
	chat: { messages: Record<string, unknown>[] }[]
}

function server(capabilities: Record<string, string[] | undefined | 'fail'>) {
	const seen: Recorded = { show: [], chat: [] }
	const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input)
		const body = JSON.parse(String(init?.body ?? '{}'))
		if (url.endsWith('/api/show')) {
			seen.show.push(body.model)
			const caps = capabilities[body.model]
			if (caps === 'fail') return new Response('{"error":"boom"}', { status: 500 })
			return new Response(JSON.stringify(caps ? { capabilities: caps } : {}), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		}
		seen.chat.push(body)
		const line = `${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' })}\n`
		return new Response(line, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } })
	}) as typeof fetch
	const provider = new OllamaProvider({ host: 'http://127.0.0.1:1', fetch: fetchImpl })
	return { provider, seen }
}

const withPicture = {
	role: 'user' as const,
	content: 'what is on it',
	attachments: [{ data: PNG, mediaType: 'image/png' }],
}

async function ask(provider: OllamaProvider, model: string, messages: unknown[]) {
	for await (const _chunk of provider.chatStream({ model, messages } as never)) {
		// drain
	}
}

describe('Ollama: pictures', () => {
	it('declares that it maps pictures', () => {
		expect(OLLAMA_CAPABILITIES.supportsVision).toBe(true)
		expect(OLLAMA_CAPABILITIES.supportsToolResultImages).toBe(true)
		expect(OLLAMA_CAPABILITIES.supportsDocuments).toBe(false)
	})

	it('sends the picture in the message images array for a model whose information lists vision', async () => {
		const { provider, seen } = server({ llava: ['completion', 'vision'] })
		await ask(provider, 'llava', [withPicture])
		expect(seen.chat[0]?.messages).toEqual([
			{ role: 'user', content: 'what is on it', images: [PNG] },
		])
	})

	it('leaves the picture out, with a note, for a model whose information has no vision', async () => {
		const { provider, seen } = server({ qwen: ['completion'] })
		await ask(provider, 'qwen', [withPicture])
		const sent = seen.chat[0]?.messages[0] as { content: string; images?: unknown }
		expect(sent.images).toBeUndefined()
		expect(sent.content).toContain('[image omitted: the current model cannot read images')
		expect(sent.content).toContain('what is on it')
	})

	it('answers supportsImageInputFor false for that model once its information was read', async () => {
		const { provider } = server({ qwen: ['completion'] })
		expect(provider.supportsImageInputFor('qwen')).toBe(true) // not read yet
		await ask(provider, 'qwen', [withPicture])
		expect(provider.supportsImageInputFor('qwen')).toBe(false)
	})

	it('sends the picture to a model whose server does not list capabilities', async () => {
		const { provider, seen } = server({ old: undefined })
		await ask(provider, 'old', [withPicture])
		expect(seen.chat[0]?.messages[0]).toMatchObject({ images: [PNG] })
		expect(provider.supportsImageInputFor('old')).toBe(true)
	})

	it('sends the picture when the model information cannot be read', async () => {
		const { provider, seen } = server({ flaky: 'fail' })
		await ask(provider, 'flaky', [withPicture])
		expect(seen.chat[0]?.messages[0]).toMatchObject({ images: [PNG] })
	})

	it('reads a model information once per model, not once per request', async () => {
		const { provider, seen } = server({ llava: ['vision'] })
		await ask(provider, 'llava', [withPicture])
		await ask(provider, 'llava', [withPicture])
		await ask(provider, 'llava', [withPicture])
		expect(provider.supportsImageInputFor('llava')).toBe(true)
		expect(seen.show).toEqual(['llava'])
		expect(seen.chat).toHaveLength(3)
	})

	it('never asks for model information on a request with no picture', async () => {
		const { provider, seen } = server({ llava: ['vision'] })
		await ask(provider, 'llava', [{ role: 'user', content: 'hello' }])
		expect(seen.show).toEqual([])
		expect(seen.chat[0]?.messages).toEqual([{ role: 'user', content: 'hello' }])
	})

	it('keeps a withheld picture out of the request', async () => {
		const { provider, seen } = server({ llava: ['vision'] })
		await ask(provider, 'llava', [
			{
				...withPicture,
				attachments: [
					{ data: PNG, mediaType: 'image/png', modelOmission: { reason: 'invalid-image' } },
				],
			},
		])
		expect(seen.chat[0]?.messages[0]).toEqual({ role: 'user', content: 'what is on it' })
	})

	it('puts a tool result picture on the tool message for a vision model', async () => {
		const { provider, seen } = server({ llava: ['vision'] })
		await ask(provider, 'llava', [
			{ role: 'user', content: 'look' },
			{
				role: 'tool',
				toolCallId: 'call_1',
				content: [
					{ type: 'text', text: 'screenshot taken' },
					{ type: 'image', data: PNG, mediaType: 'image/png' },
				],
			},
		])
		const tool = seen.chat[0]?.messages[1] as { role: string; content: string; images: string[] }
		expect(tool.role).toBe('tool')
		expect(tool.images).toEqual([PNG])
		expect(tool.content).toContain('screenshot taken')
		expect(tool.content).not.toContain('not renderable')
	})

	it('names a tool result picture as left out for a text-only model', async () => {
		const { provider, seen } = server({ qwen: ['completion'] })
		await ask(provider, 'qwen', [
			{ role: 'user', content: 'look' },
			{
				role: 'tool',
				toolCallId: 'call_1',
				content: [{ type: 'image', data: PNG, mediaType: 'image/png' }],
			},
		])
		const tool = seen.chat[0]?.messages[1] as { content: string; images?: unknown }
		expect(tool.images).toBeUndefined()
		expect(tool.content).toContain('[image omitted: the current model cannot read images')
	})

	it('asking whether a model reads pictures never calls the server', () => {
		const { provider, seen } = server({ llava: ['vision'] })
		expect(provider.supportsImageInputFor('llava')).toBe(true)
		expect(seen.show).toEqual([])
	})

	describe('a model information read that never answers', () => {
		afterEach(() => vi.useRealTimers())

		it('does not stall the request: it goes on with the picture and asks again next time', async () => {
			vi.useFakeTimers()
			const shows: string[] = []
			const chats: Record<string, unknown>[] = []
			const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				const body = JSON.parse(String(init?.body ?? '{}'))
				if (String(input).endsWith('/api/show')) {
					shows.push(body.model)
					return new Promise<Response>(() => {})
				}
				chats.push(body)
				const line = `${JSON.stringify({ model: body.model, message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' })}\n`
				return new Response(line, { status: 200 })
			}) as typeof fetch
			const provider = new OllamaProvider({ host: 'http://127.0.0.1:1', fetch: fetchImpl })
			const run = ask(provider, 'llava', [withPicture])
			await vi.advanceTimersByTimeAsync(5_000)
			await run
			expect(chats).toHaveLength(1)
			expect((chats[0]?.messages as { images?: string[] }[])[0]?.images).toEqual([PNG])
			const again = ask(provider, 'llava', [withPicture])
			await vi.advanceTimersByTimeAsync(5_000)
			await again
			expect(shows).toEqual(['llava', 'llava'])
		})
	})
})
