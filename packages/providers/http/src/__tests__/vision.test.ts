import { afterEach, describe, expect, it, vi } from 'vitest'

import { HTTP_CAPABILITIES, HttpProvider } from '../client.js'
import type { HttpDialect } from '../types.js'

/**
 * This driver does not map attachments on either dialect, and says so.
 *
 * Shipping without a wire shape is legitimate; claiming one you do not have
 * is not. What this pins is drift in either direction — flipping the flag
 * without writing the mapping makes the runtime stop warning about images
 * that still vanish, and writing the mapping without flipping the flag
 * makes it keep warning about images that now arrive. The runtime reads the
 * flag before the request is built, so the flag is the contract.
 */

const PNG = 'iVBORw0KGgo='

afterEach(() => {
	vi.unstubAllGlobals()
})

async function bodyFor(dialect: HttpDialect, attachments: unknown[]) {
	let captured: Record<string, unknown> = {}
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			captured = JSON.parse(String(init.body))
			return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
		}),
	)

	const provider = new HttpProvider({ baseURL: 'https://example.test/v1', apiKey: 'k', dialect })
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'what is this', attachments }],
	} as never)) {
		// drain
	}
	return captured
}

describe('the capability claim and the mapper agree', () => {
	it('declares that images are not mapped', () => {
		expect(HTTP_CAPABILITIES.supportsVision).toBe(false)
	})

	it('declares that documents are not mapped', () => {
		expect(HTTP_CAPABILITIES.supportsDocuments).toBe(false)
	})

	for (const dialect of ['openai', 'anthropic'] as HttpDialect[]) {
		it(`sends no image part on the ${dialect} dialect`, async () => {
			const body = await bodyFor(dialect, [{ type: 'image', data: PNG, mediaType: 'image/png' }])

			expect(JSON.stringify(body)).not.toContain('image_url')
			expect(JSON.stringify(body)).not.toContain('"image"')
		})

		it(`does not smuggle the payload into the text on the ${dialect} dialect`, async () => {
			const body = await bodyFor(dialect, [
				{ type: 'image', data: 'A'.repeat(2048), mediaType: 'image/png' },
			])

			// Dropping is the declared behaviour; stringifying it into the
			// prompt would be worse than dropping — unreadable and billed.
			expect(JSON.stringify(body)).not.toContain('A'.repeat(64))
		})

		it(`still sends the message text on the ${dialect} dialect`, async () => {
			const body = await bodyFor(dialect, [{ type: 'image', data: PNG, mediaType: 'image/png' }])

			expect(JSON.stringify(body)).toContain('what is this')
		})
	}
})
