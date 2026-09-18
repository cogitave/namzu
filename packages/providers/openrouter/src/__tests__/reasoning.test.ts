/**
 * Reasoning, in both directions, on the OpenRouter driver.
 *
 * Defect this file exists for: the driver had zero references to reasoning. A
 * model that returns it — `nvidia/nemotron-3.5-lightning:free` returns both
 * `message.reasoning` and `reasoning_details` — produced thinking the kernel
 * never saw, so the reasoning pane stayed empty and `thinking` was refused
 * outright while five other drivers rendered it.
 *
 * The wire, captured 2026-09-18 from the free model above:
 *
 *   {"id":"gen-…","choices":[{"index":0,"delta":{"content":"","role":"assistant",
 *     "reasoning":"17 ","reasoning_details":[{"type":"reasoning.text","text":"17 ",
 *     "format":"unknown","index":0}]},"finish_reason":null}]}
 *
 * Two things in that frame are load-bearing. The text arrives TWICE — a flat
 * `reasoning` string and the same text inside `reasoning_details` — so emitting
 * both would double every block. And every reasoning frame carries
 * `"content":""`, so "content arrived" cannot be `!== undefined`, or each block
 * would close on the frame that opened it.
 */

import type { ChatCompletionParams, StreamChunk } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenRouterProvider } from '../client.js'

afterEach(() => {
	vi.unstubAllGlobals()
})

const MODEL = 'nvidia/nemotron-3.5-lightning:free'

function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
	return JSON.stringify({
		id: 'gen-test',
		object: 'chat.completion.chunk',
		created: 0,
		model: MODEL,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})
}

function usageFrame(): string {
	return JSON.stringify({
		id: 'gen-test',
		object: 'chat.completion.chunk',
		created: 0,
		model: MODEL,
		choices: [{ index: 0, delta: { content: '', role: 'assistant' }, finish_reason: 'stop' }],
		usage: {
			prompt_tokens: 20,
			completion_tokens: 64,
			total_tokens: 84,
			completion_tokens_details: { reasoning_tokens: 61 },
		},
	})
}

function providerOver(frames: string[]): OpenRouterProvider {
	const body = `${frames.map((f) => `data: ${f}\n\n`).join('')}data: [DONE]\n\n`
	vi.stubGlobal(
		'fetch',
		vi
			.fn()
			.mockResolvedValue(
				new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
			),
	)
	return new OpenRouterProvider({ apiKey: 'test-key', baseUrl: 'https://example.test/api/v1' })
}

async function collect(
	provider: OpenRouterProvider,
	params: Partial<ChatCompletionParams> = {},
): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream({
		model: MODEL,
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	})) {
		chunks.push(chunk)
	}
	return chunks
}

function reasoningOf(chunks: readonly StreamChunk[]) {
	return chunks.flatMap((chunk) => (chunk.delta.reasoning ? [chunk.delta.reasoning] : []))
}

/** Fragments that carry text or an opaque payload; a `done` marker carries neither. */
function fragmentsOf(chunks: readonly StreamChunk[]) {
	return reasoningOf(chunks).filter((fragment) => fragment.done !== true)
}

describe('@namzu/openrouter — reasoning reaches the kernel', () => {
	it('yields the text once, from reasoning_details, not from the flat duplicate', async () => {
		const chunks = await collect(
			providerOver([
				frame({
					content: '',
					role: 'assistant',
					reasoning: '17 times 3 is',
					reasoning_details: [
						{ type: 'reasoning.text', text: '17 times 3 is', format: 'unknown', index: 0 },
					],
				}),
				frame({ content: '51' }),
				frame({}, 'stop'),
				usageFrame(),
			]),
		)

		const fragments = fragmentsOf(chunks)
		expect(fragments).toHaveLength(1)
		expect(fragments[0]).toMatchObject({ index: 0, type: 'thinking', text: '17 times 3 is' })
		expect(
			chunks
				.map((c) => c.delta.content)
				.filter(Boolean)
				.join(''),
		).toBe('51')
	})

	it('carries the flat `reasoning` string when the details array is absent', async () => {
		const chunks = await collect(
			providerOver([
				frame({ content: '', reasoning: 'a thought' }),
				frame({ content: 'ok' }),
				frame({}, 'stop'),
			]),
		)

		expect(fragmentsOf(chunks)).toEqual([{ index: 0, type: 'thinking', text: 'a thought' }])
	})

	it('closes an open block when output starts, and not on an empty content', async () => {
		const chunks = await collect(
			providerOver([
				frame({
					content: '',
					reasoning: 'thinking',
					reasoning_details: [{ type: 'reasoning.text', text: 'thinking', index: 0 }],
				}),
				frame({
					content: '',
					reasoning: ' more',
					reasoning_details: [{ type: 'reasoning.text', text: ' more', index: 0 }],
				}),
				frame({ content: 'answer' }),
				frame({}, 'stop'),
			]),
		)

		// Two fragments, no `done` between them (an empty content is not
		// output), then one close before the answer.
		expect(fragmentsOf(chunks)).toEqual([
			{ index: 0, type: 'thinking', text: 'thinking' },
			{ index: 0, type: 'thinking', text: ' more' },
		])
		expect(reasoningOf(chunks).filter((fragment) => fragment.done)).toEqual([
			{ index: 0, done: true },
		])
		const closeIndex = chunks.findIndex((c) => c.delta.reasoning?.done)
		const answerIndex = chunks.findIndex((c) => c.delta.content === 'answer')
		expect(closeIndex).toBeLessThan(answerIndex)
	})

	it('closes the open blocks when a tool call starts', async () => {
		const chunks = await collect(
			providerOver([
				frame({
					content: '',
					reasoning: 'let me read it',
					reasoning_details: [{ type: 'reasoning.text', text: 'let me read it', index: 0 }],
				}),
				frame({
					content: '',
					tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read' } }],
				}),
				frame({}, 'tool_calls'),
			]),
		)

		expect(reasoningOf(chunks).at(-1)).toEqual({ index: 0, done: true })
	})

	it('carries an encrypted detail as an opaque block instead of dropping it', async () => {
		const chunks = await collect(
			providerOver([
				frame({
					content: '',
					reasoning_details: [{ type: 'reasoning.encrypted', data: 'ciphertext-opaque', index: 0 }],
				}),
				frame({ content: 'ok' }),
				frame({}, 'stop'),
			]),
		)

		expect(fragmentsOf(chunks)).toEqual([
			{ index: 0, type: 'redacted_thinking', encrypted: 'ciphertext-opaque' },
		])
	})

	it('reports the reasoning share of the completion tokens without adding to them', async () => {
		const chunks = await collect(
			providerOver([frame({ content: 'ok' }), frame({}, 'stop'), usageFrame()]),
		)

		const usage = chunks.at(-1)?.usage
		// 64 completion tokens, 61 of which were thinking: a subset, not a sum.
		expect(usage).toMatchObject({ completionTokens: 64, totalTokens: 84, reasoningTokens: 61 })
	})

	it('leaves reasoningTokens absent when the vendor does not report a split', async () => {
		const chunks = await collect(providerOver([frame({ content: 'ok' }), frame({}, 'stop')]))
		expect(chunks.every((chunk) => chunk.usage === undefined)).toBe(true)
	})
})

describe('@namzu/openrouter — thinking controls reach the wire', () => {
	function bodyFor(params: Partial<ChatCompletionParams>): Record<string, unknown> {
		const provider = new OpenRouterProvider({ apiKey: 'test-key' })
		return (
			provider as unknown as {
				buildRequestBody(params: ChatCompletionParams, stream: boolean): Record<string, unknown>
			}
		).buildRequestBody(
			{ model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...params },
			true,
		)
	}

	it('sends no reasoning field when the caller asked for nothing', () => {
		expect(bodyFor({})).not.toHaveProperty('reasoning')
	})

	it('maps manual thinking with a budget onto max_tokens', () => {
		expect(bodyFor({ thinking: { type: 'enabled', budgetTokens: 4_096 } })).toMatchObject({
			reasoning: { enabled: true, max_tokens: 4_096 },
		})
	})

	it('maps adaptive thinking onto enabled without a budget', () => {
		expect(bodyFor({ thinking: { type: 'adaptive' } })).toMatchObject({
			reasoning: { enabled: true },
		})
	})

	it('maps a disabled request onto enabled: false rather than dropping it', () => {
		expect(bodyFor({ thinking: { type: 'disabled' } })).toMatchObject({
			reasoning: { enabled: false },
		})
	})

	it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const)(
		'forwards effort %s',
		(effort) => {
			expect(bodyFor({ effort })).toMatchObject({ reasoning: { effort } })
		},
	)

	it.each(['max', 'ultra'] as const)(
		'refuses effort %s instead of sending a wrong level',
		async (effort) => {
			const provider = new OpenRouterProvider({
				apiKey: 'test-key',
				baseUrl: 'https://example.test/api/v1',
			})
			await expect(collect(provider, { effort })).rejects.toThrow(/cannot carry effort/)
		},
	)
})
