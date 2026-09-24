import { type StreamChunk, isProviderRequestError } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OpenRouterProvider } from '../client.js'

/**
 * The driver cast `finish_reason` straight through. `error` — the upstream
 * model failed mid-generation — reached the runtime as a finish reason outside
 * its union, and a tool call the failure cut off read as one the model had
 * finished and got wrong.
 */

afterEach(() => {
	vi.unstubAllGlobals()
})

function frame(finishReason: string | null): string {
	return JSON.stringify({
		id: 'gen-test',
		choices: [{ index: 0, delta: { content: 'x' }, finish_reason: finishReason }],
	})
}

async function chunksOf(frames: string[]): Promise<StreamChunk[]> {
	const body = `${frames.map((f) => `data: ${f}\n\n`).join('')}data: [DONE]\n\n`
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(
				new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
			),
	)
	const provider = new OpenRouterProvider({
		apiKey: 'test-key',
		baseUrl: 'https://example.test/api/v1',
	})
	const out: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: 'm',
		messages: [{ role: 'user', content: 'hi' }],
	})) {
		out.push(chunk)
	}
	return out
}

describe('OpenRouter finish reasons', () => {
	it.each([
		['length', 'length'],
		['tool_calls', 'tool_calls'],
		['content_filter', 'content_filter'],
		['stop', 'stop'],
	])('reports %s as %s', async (reason, expected) => {
		const chunks = await chunksOf([frame(null), frame(reason)])
		expect(chunks[0]?.finishReason).toBeUndefined()
		expect(chunks.at(-1)?.finishReason).toBe(expected)
	})

	it('fails a stream whose upstream model failed', async () => {
		const error = await chunksOf([frame(null), frame('error')]).then(
			() => undefined,
			(err: unknown) => err,
		)
		expect(isProviderRequestError(error)).toBe(true)
		expect(error).toMatchObject({ kind: 'server', providerId: 'openrouter' })
	})
})
