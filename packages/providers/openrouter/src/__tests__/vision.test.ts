import { describe, expect, it, vi } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * User attachments were dropped outright, so someone who attached a
 * screenshot got a turn about nothing — on a gateway whose whole point is
 * reaching models that can see.
 */

const PNG = 'iVBORw0KGgoAAAANSUhEUg'

function captureBody() {
	const bodies: Record<string, unknown>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			bodies.push(JSON.parse(init.body))
			return { ok: true, body: null, json: async () => ({ choices: [] }) } as never
		}),
	)
	return { provider: new OpenRouterProvider({ apiKey: 'k' }), bodies }
}

async function send(provider: OpenRouterProvider, messages: unknown[]): Promise<void> {
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

describe('user attachments', () => {
	it('sends the image as a data URI part beside the text', async () => {
		const { provider, bodies } = captureBody()
		await send(provider, [
			{
				role: 'user',
				content: 'what is this',
				attachments: [{ data: PNG, mediaType: 'image/png' }],
			},
		])

		const messages = bodies[0]?.messages as Array<{
			content: Array<{ type: string; text?: string; image_url?: { url: string } }>
		}>
		const parts = messages[0]?.content ?? []
		expect(parts[0]).toEqual({ type: 'text', text: 'what is this' })
		expect(parts[1]?.image_url?.url).toBe(`data:image/png;base64,${PNG}`)
	})

	it('leaves a message with no attachments as a plain string', async () => {
		const { provider, bodies } = captureBody()
		await send(provider, [{ role: 'user', content: 'plain' }])

		// Nothing about an ordinary request should change shape.
		const messages = bodies[0]?.messages as Array<{ content: unknown }>
		expect(messages[0]?.content).toBe('plain')
	})

	it('names a format it cannot send rather than inlining it', async () => {
		const { provider, bodies } = captureBody()
		await send(provider, [
			{ role: 'user', content: 'look', attachments: [{ data: PNG, mediaType: 'image/tiff' }] },
		])

		const serialized = JSON.stringify(bodies[0])
		expect(serialized).not.toContain(PNG)
		expect(serialized).toContain('image/tiff')
	})

	it('carries several attachments in order', async () => {
		const { provider, bodies } = captureBody()
		await send(provider, [
			{
				role: 'user',
				content: 'compare',
				attachments: [
					{ data: PNG, mediaType: 'image/png' },
					{ data: PNG, mediaType: 'image/webp' },
				],
			},
		])

		const messages = bodies[0]?.messages as Array<{
			content: Array<{ type: string; image_url?: { url: string } }>
		}>
		const images = (messages[0]?.content ?? []).filter((p) => p.type === 'image_url')
		expect(images).toHaveLength(2)
		expect(images[1]?.image_url?.url.startsWith('data:image/webp;base64,')).toBe(true)
	})
})
