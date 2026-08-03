import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'
import type { HttpDialect } from '../types.js'

/**
 * Tool messages are text-only on both of this driver's dialects, so a tool
 * result carrying an image has to degrade. The question is how.
 *
 * Dumping the blocks as JSON would put the base64 into the prompt: the
 * model pays for every character and can read none of them, and — worse —
 * reads a JSON object where a picture should be and has no way to tell that
 * something was withheld. The named placeholder says what was there and how
 * big it was, which is the difference between a degraded result and a
 * misleading one.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

const PNG = 'iVBORw0KGgo='

async function bodyFor(dialect: HttpDialect, content: unknown): Promise<string> {
	let captured = ''
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: RequestInit) => {
			captured = String(init.body)
			return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
		}),
	)

	const provider = new HttpProvider({ baseURL: 'https://example.test/v1', apiKey: 'k', dialect })
	for await (const _chunk of provider.chatStream({
		model: 'm',
		messages: [
			{ role: 'user', content: 'take a shot' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_1', type: 'function', function: { name: 'screenshot', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'call_1', content },
		],
	} as never)) {
		// drain
	}
	return captured
}

for (const dialect of ['openai', 'anthropic'] as HttpDialect[]) {
	describe(`a tool result on the ${dialect} dialect degrades honestly`, () => {
		it('names the media type instead of carrying the payload', async () => {
			const body = await bodyFor(dialect, [{ type: 'image', mediaType: 'image/png', data: PNG }])

			expect(body).toContain('image/png')
		})

		it('keeps the base64 out of the prompt', async () => {
			const body = await bodyFor(dialect, [
				{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(2048) },
			])

			expect(body).not.toContain('A'.repeat(64))
		})

		it('says how big it was, so the model knows what it is missing', async () => {
			const body = await bodyFor(dialect, [
				{ type: 'image', mediaType: 'image/png', data: 'A'.repeat(4096) },
			])

			expect(body).toMatch(/\d+(\.\d+)? (B|KB|MB)/)
		})

		it('keeps the text that sat alongside the image', async () => {
			const body = await bodyFor(dialect, [
				{ type: 'text', text: 'captured the window' },
				{ type: 'image', mediaType: 'image/png', data: PNG },
			])

			expect(body).toContain('captured the window')
		})

		it('passes a plain string result straight through', async () => {
			const body = await bodyFor(dialect, 'just text')

			expect(body).toContain('just text')
		})

		it('names a document by its filename', async () => {
			const body = await bodyFor(dialect, [
				{ type: 'document', mediaType: 'application/pdf', data: 'JVBER', name: 'lease.pdf' },
			])

			expect(body).toContain('lease.pdf')
		})
	})
}
