import { readFileSync } from 'node:fs'
import type { ChatCompletionParams, StreamChunk, TokenUsage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../client.js'

type Frame = Record<string, unknown>

// Usage frames recorded from two consecutive model calls of one turn. The first
// writes the cache (26 378 tokens), the second reads it back and writes a little
// more; `input_tokens` is 4 and 2: only what follows the last cache breakpoint.
const recorded = JSON.parse(
	readFileSync(new URL('./fixtures/subscription-usage-frames.json', import.meta.url), 'utf8'),
) as { calls: Frame[][] }

const request: ChatCompletionParams = {
	model: 'claude-haiku-5-5',
	messages: [{ role: 'user', content: 'Explain' }],
}

async function lastUsage(frames: Frame[]): Promise<TokenUsage | undefined> {
	const provider = new AnthropicProvider({ apiKey: 'fixture' })
	;(provider as unknown as { client: unknown }).client = {
		messages: {
			create: async () =>
				(async function* () {
					for (const frame of frames) yield frame
					yield { type: 'message_stop' }
				})(),
		},
	}
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream(request)) chunks.push(chunk)
	return chunks.flatMap((c) => (c.usage ? [c.usage] : [])).at(-1)
}

describe('usage on the subscription sign-in wire', () => {
	it('keeps the cache figures and reports the whole prompt, not the uncached remainder', async () => {
		const usage = await lastUsage(recorded.calls[0] as Frame[])
		expect(usage?.promptTokens).toBe(4)
		expect(usage?.cacheWriteTokens).toBe(26378)
		expect(usage?.cachedTokens).toBe(0)
		expect(usage?.completionTokens).toBe(131)
		expect(usage?.fullPromptTokens).toBe(4 + 26378)
	})

	it('counts a warm call as read plus written plus uncached', async () => {
		const usage = await lastUsage(recorded.calls[1] as Frame[])
		expect(usage?.promptTokens).toBe(2)
		expect(usage?.cachedTokens).toBe(26378)
		expect(usage?.cacheWriteTokens).toBe(163)
		expect(usage?.fullPromptTokens).toBe(2 + 26378 + 163)
	})
})
