import type { StreamChunk } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { OpenAIProvider } from '../client.js'

/**
 * A `content_filter` finish is the API declining to answer. The driver says
 * so with a `refusal` on the finish chunk, so the runtime can tell a declined
 * request from an empty reply.
 */

async function chunksFor(finishReason: string): Promise<StreamChunk[]> {
	const provider = new OpenAIProvider({ apiKey: 'test-key' })
	;(provider as unknown as { client: unknown }).client = {
		chat: {
			completions: {
				create: async () =>
					(async function* () {
						yield {
							id: 'c1',
							choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
						}
					})(),
			},
		},
	}
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'gpt-test',
		messages: [{ role: 'user', content: 'q' }],
	})) {
		out.push(chunk)
	}
	return out
}

describe('OpenAI refusals', () => {
	it('says a content filter is a refusal', async () => {
		const finish = (await chunksFor('content_filter')).find((chunk) => chunk.finishReason)
		expect(finish?.finishReason).toBe('content_filter')
		expect(finish?.refusal).toEqual({})
	})

	it('says nothing of a refusal on a normal finish', async () => {
		const chunks = await chunksFor('stop')
		expect(chunks.some((chunk) => chunk.refusal !== undefined)).toBe(false)
	})
})
