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

function frame(finishReason: string | null, nativeFinishReason?: string | null): string {
	return JSON.stringify({
		id: 'gen-test',
		choices: [
			{
				index: 0,
				delta: { content: 'x' },
				finish_reason: finishReason,
				...(nativeFinishReason !== undefined ? { native_finish_reason: nativeFinishReason } : {}),
			},
		],
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

	describe('a proxied backend context-window stop', () => {
		// OpenRouter normalises every backend to one of five reasons, so a
		// proxied Anthropic model's context window and a proxied OpenAI
		// model's output limit both arrive as plain `finish_reason: 'length'`.
		// `native_finish_reason` carries the backend's own word for it
		// verbatim, and is the only way left to tell them apart.
		it.each([
			'model_context_window_exceeded',
			'model_length',
			'context_length',
			'context_length_exceeded',
		])('marks finishDetail: context_window when native_finish_reason is %s', async (native) => {
			const chunks = await chunksOf([frame(null), frame('length', native)])
			const last = chunks.at(-1)
			expect(last?.finishReason).toBe('length')
			expect(last?.finishDetail).toBe('context_window')
		})

		it('gives no finishDetail for a plain output-limit length, with or without a native reason', async () => {
			for (const native of [undefined, null, 'length', 'max_tokens']) {
				const chunks = await chunksOf([frame(null), frame('length', native)])
				const last = chunks.at(-1)
				expect(last?.finishReason).toBe('length')
				expect(last?.finishDetail).toBeUndefined()
			}
		})

		it('gives no finishDetail to a non-length finish, even with a context-window native reason', async () => {
			// The distinction only means anything for 'length': a normal stop
			// or a tool call is not cut off by anything.
			const chunks = await chunksOf([frame(null), frame('stop', 'model_context_window_exceeded')])
			expect(chunks.at(-1)?.finishReason).toBe('stop')
			expect(chunks.at(-1)?.finishDetail).toBeUndefined()
		})
	})
})
