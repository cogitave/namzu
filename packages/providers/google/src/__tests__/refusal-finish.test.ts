import type { StreamChunk } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import { GoogleProvider } from '../client.js'

/**
 * A safety block (a blocked prompt, or a candidate stopped for safety) is the
 * API declining to answer. The finish chunk says so with a `refusal`, so the
 * runtime can tell a declined request from an empty reply.
 */

async function chunksFor(frame: unknown): Promise<StreamChunk[]> {
	const fetch = vi
		.fn<typeof globalThis.fetch>()
		.mockResolvedValue(new Response(`data: ${JSON.stringify(frame)}\n\n`))
	const provider = new GoogleProvider({ apiKey: 'fixture-key', fetch })
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'gemini-2.5-flash',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(chunk)
	}
	return out
}

describe('Gemini refusals', () => {
	it('says a safety stop is a refusal', async () => {
		const chunks = await chunksFor({
			candidates: [{ finishReason: 'SAFETY' }],
		})
		const finish = chunks.find((chunk) => chunk.finishReason)
		expect(finish?.finishReason).toBe('content_filter')
		expect(finish?.refusal).toEqual({})
	})

	it('says a blocked prompt is a refusal', async () => {
		const chunks = await chunksFor({
			promptFeedback: { blockReason: 'SAFETY' },
		})
		expect(chunks.find((chunk) => chunk.finishReason)?.refusal).toEqual({})
	})

	it('says nothing of a refusal on a normal finish', async () => {
		const chunks = await chunksFor({
			candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
		})
		expect(chunks.some((chunk) => chunk.refusal !== undefined)).toBe(false)
	})
})
