import { describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'

/**
 * User attachments were dropped on both dialects, so someone who attached
 * a screenshot got a turn about nothing. Each dialect carries an image in
 * a different shape, and this driver speaks both — so both are asserted
 * through the real request the driver builds.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg'

function captureBody(dialect: 'openai' | 'anthropic') {
	const bodies: Record<string, unknown>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			bodies.push(JSON.parse(init.body))
			return { ok: true, body: null, json: async () => ({ choices: [], content: [] }) } as never
		}),
	)
	const provider = new HttpProvider({
		baseURL: 'http://localhost:1234/v1',
		dialect,
		model: 'test-model',
	})
	return { provider, bodies }
}

async function send(provider: HttpProvider, messages: unknown[]): Promise<void> {
	try {
		for await (const _ of provider.chatStream({
			model: 'test-model',
			messages: messages as never,
			maxTokens: 64,
		})) {
			// drain
		}
	} catch {
		// The fake response is not a real stream; the body is already captured.
	}
}

const withImage = (mediaType = 'image/png') => [
	{ role: 'user', content: 'what is this', attachments: [{ data: PNG, mediaType }] },
]

describe('openai dialect', () => {
	it('sends the image as a data URI part beside the text', async () => {
		const { provider, bodies } = captureBody('openai')
		await send(provider, withImage())

		const messages = bodies[0]?.messages as Array<{
			content: Array<{ type: string; text?: string; image_url?: { url: string } }>
		}>
		const parts = messages[0]?.content ?? []
		expect(parts[0]).toEqual({ type: 'text', text: 'what is this' })
		expect(parts[1]?.image_url?.url).toBe(`data:image/png;base64,${PNG}`)
	})

	it('leaves a message with no attachments as a plain string', async () => {
		const { provider, bodies } = captureBody('openai')
		await send(provider, [{ role: 'user', content: 'plain' }])

		// Nothing about an ordinary request should change shape.
		const messages = bodies[0]?.messages as Array<{ content: unknown }>
		expect(messages[0]?.content).toBe('plain')
	})

	it('names a format it cannot send rather than inlining it', async () => {
		const { provider, bodies } = captureBody('openai')
		await send(provider, withImage('image/tiff'))

		const serialized = JSON.stringify(bodies[0])
		expect(serialized).not.toContain(PNG)
		expect(serialized).toContain('image/tiff')
	})
})

describe('anthropic dialect', () => {
	it('sends the image as a base64 source block beside the text', async () => {
		const { provider, bodies } = captureBody('anthropic')
		await send(provider, withImage())

		const messages = bodies[0]?.messages as Array<{
			content: Array<{ type: string; text?: string; source?: { data: string; media_type: string } }>
		}>
		const parts = messages[0]?.content ?? []
		expect(parts[0]).toEqual({ type: 'text', text: 'what is this' })
		expect(parts[1]?.type).toBe('image')
		expect(parts[1]?.source?.media_type).toBe('image/png')
		expect(parts[1]?.source?.data).toBe(PNG)
	})

	it('leaves a message with no attachments as a plain string', async () => {
		const { provider, bodies } = captureBody('anthropic')
		await send(provider, [{ role: 'user', content: 'plain' }])

		const messages = bodies[0]?.messages as Array<{ content: unknown }>
		expect(messages[0]?.content).toBe('plain')
	})

	it('names a format it cannot send rather than inlining it', async () => {
		const { provider, bodies } = captureBody('anthropic')
		await send(provider, withImage('image/tiff'))

		const serialized = JSON.stringify(bodies[0])
		expect(serialized).not.toContain(PNG)
		expect(serialized).toContain('image/tiff')
	})
})
