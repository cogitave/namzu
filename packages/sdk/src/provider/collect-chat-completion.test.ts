/**
 * Behavioural contract for `collectChatCompletion()` (ses_001-tool-stream-events phase 1A):
 *
 * - Drains a `StreamChunk` async iterable into a single
 *   `ChatCompletionResponse` matching the legacy `provider.chat()` shape.
 * - Concatenates `delta.content` in arrival order; null when no text
 *   chunks ever arrive.
 * - Buckets tool-call argument fragments by `index`; emits `toolCalls`
 *   sorted by index. `id` and `function.name` come from the first chunk
 *   that supplies them; `function.arguments` is the concatenation of all
 *   `arguments` fragments for that index.
 * - Latest-wins for `finishReason` and `usage`; defaults
 *   `finishReason: 'stop'` and zero usage if the provider omits them
 *   (defensive — a vendor SDK has shipped this shape before).
 * - Throws if any chunk surfaces a `chunk.error`.
 *
 * Phase 2 swaps every internal `provider.chat()` call site for
 * `collectChatCompletion(provider.chatStream())`; the response shape parity guarded
 * here is what makes that swap safe.
 */

import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../types/provider/stream.js'

import { collectChatCompletion } from './collect-chat-completion.js'

async function* fromArray(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) yield chunk
}

describe('collectChatCompletion()', () => {
	it('aggregates text-only stream into single content string', async () => {
		const result = await collectChatCompletion(
			fromArray([
				{ id: 'm1', delta: { content: 'hel' } },
				{ id: 'm1', delta: { content: 'lo' } },
				{ id: 'm1', delta: { content: ' world' } },
				{ id: 'm1', delta: {}, finishReason: 'stop' },
			]),
		)
		expect(result.message.content).toBe('hello world')
		expect(result.message.toolCalls).toBeUndefined()
		expect(result.finishReason).toBe('stop')
		expect(result.id).toBe('m1')
	})

	it('returns content: null when no text chunks arrive', async () => {
		const result = await collectChatCompletion(
			fromArray([{ id: 'm', delta: {}, finishReason: 'stop' }]),
		)
		expect(result.message.content).toBeNull()
	})

	it('buckets parallel tool calls by index, preserves order', async () => {
		const result = await collectChatCompletion(
			fromArray([
				{
					id: 'm',
					delta: {
						toolCalls: [
							{ index: 0, id: 'toolu_a', function: { name: 'read' } },
							{ index: 1, id: 'toolu_b', function: { name: 'WebSearch' } },
						],
					},
				},
				{
					id: 'm',
					delta: {
						toolCalls: [{ index: 1, function: { arguments: '{"query":"x"}' } }],
					},
				},
				{
					id: 'm',
					delta: {
						toolCalls: [
							{ index: 0, function: { arguments: '{"file_path":' } },
							{ index: 0, function: { arguments: '"/a"}' } },
						],
					},
				},
				{ id: 'm', delta: {}, finishReason: 'tool_calls' },
			]),
		)
		expect(result.message.toolCalls).toEqual([
			{
				id: 'toolu_a',
				type: 'function',
				function: { name: 'read', arguments: '{"file_path":"/a"}' },
			},
			{
				id: 'toolu_b',
				type: 'function',
				function: { name: 'WebSearch', arguments: '{"query":"x"}' },
			},
		])
		expect(result.finishReason).toBe('tool_calls')
	})

	it('latest finishReason and usage win', async () => {
		const result = await collectChatCompletion(
			fromArray([
				{ id: 'm', delta: {}, finishReason: 'stop' },
				{
					id: 'm',
					delta: {},
					finishReason: 'length',
					usage: {
						promptTokens: 100,
						completionTokens: 50,
						totalTokens: 150,
						cachedTokens: 0,
						cacheWriteTokens: 0,
					},
				},
			]),
		)
		expect(result.finishReason).toBe('length')
		expect(result.usage.totalTokens).toBe(150)
	})

	it('defaults finishReason to stop and usage to zero when provider omits them', async () => {
		const result = await collectChatCompletion(fromArray([{ id: 'm', delta: { content: 'hi' } }]))
		expect(result.finishReason).toBe('stop')
		expect(result.usage).toEqual({
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		})
	})

	it('throws on chunk.error', async () => {
		await expect(
			collectChatCompletion(
				fromArray([
					{ id: 'm', delta: { content: 'hi' } },
					{ id: 'm', delta: {}, error: 'rate limited' },
				]),
			),
		).rejects.toThrow('rate limited')
	})
})

/**
 * Reasoning was dropped here, and the drop was invisible.
 *
 * `StreamChunk.delta.reasoning` has existed since the thinking work landed,
 * `AssistantMessage.reasoning` is documented as "replayed verbatim and ahead
 * of the text/tool blocks", and the run loop
 * (`runtime/query/iteration/stream-turn.ts`) assembles it correctly. This
 * helper — the path every non-streaming caller takes — threw it away, so the
 * same stream produced a message with reasoning through one route and without
 * it through the other.
 *
 * That is not cosmetic for every vendor. DeepSeek requires an assistant turn's
 * reasoning back on the next request whenever tool calls are in play; a
 * message assembled here had already lost it.
 */
describe('collectChatCompletion() — reasoning blocks', () => {
	it('carries the exact opaque replay envelope from the completed stream', async () => {
		const replayState = {
			kind: 'fixture-native-state',
			version: 7,
			nested: { signature: 'opaque' },
		}
		const result = await collectChatCompletion(
			fromArray([
				{ id: 'm', delta: { reasoning: { index: 0, text: 'thought' } } },
				{ id: 'm', delta: {}, finishReason: 'stop', replayState },
			]),
		)

		expect(result.message.replayState).toBe(replayState)
	})

	it('buckets reasoning fragments by index and concatenates in arrival order', async () => {
		const result = await collectChatCompletion(
			fromArray([
				{ id: 'm', delta: { reasoning: { index: 0, type: 'thinking', text: 'first ' } } },
				{ id: 'm', delta: { reasoning: { index: 0, text: 'second' } } },
				{ id: 'm', delta: { content: 'answer' }, finishReason: 'stop' },
			]),
		)
		expect(result.message.reasoning).toEqual([{ type: 'thinking', text: 'first second' }])
		expect(result.message.content).toBe('answer')
	})

	it('keeps two blocks apart and emits them in index order', async () => {
		// Arrive interleaved and out of order on purpose: a `push`-based
		// implementation would concatenate them into one block, and a
		// last-write-wins one would lose the first.
		const result = await collectChatCompletion(
			fromArray([
				{ id: 'm', delta: { reasoning: { index: 1, text: 'B1' } } },
				{ id: 'm', delta: { reasoning: { index: 0, text: 'A1' } } },
				{ id: 'm', delta: { reasoning: { index: 1, text: 'B2' } } },
				{ id: 'm', delta: {}, finishReason: 'stop' },
			]),
		)
		expect(result.message.reasoning?.map((b) => b.text)).toEqual(['A1', 'B1B2'])
	})

	it('carries a signature and a redacted block’s payload through', async () => {
		// The signature is what makes a replayed block acceptable to the
		// vendors that sign them; dropping it turns a valid replay into a
		// rejected one.
		const result = await collectChatCompletion(
			fromArray([
				{ id: 'm', delta: { reasoning: { index: 0, text: 'thought' } } },
				{ id: 'm', delta: { reasoning: { index: 0, signature: 'sig-1' } } },
				{ id: 'm', delta: { reasoning: { index: 1, type: 'redacted_thinking', encrypted: 'op' } } },
				{ id: 'm', delta: {}, finishReason: 'stop' },
			]),
		)
		expect(result.message.reasoning?.[0]).toEqual({
			type: 'thinking',
			text: 'thought',
			signature: 'sig-1',
		})
		expect(result.message.reasoning?.[1]).toEqual({
			type: 'redacted_thinking',
			text: '',
			encrypted: 'op',
		})
	})

	it('omits the key entirely when no reasoning arrived', async () => {
		// An empty array reads as "the model did not reason"; absence reads as
		// "nobody asked". They are different claims and the second is the true
		// one for every non-thinking turn.
		const result = await collectChatCompletion(
			fromArray([{ id: 'm', delta: { content: 'hi' }, finishReason: 'stop' }]),
		)
		expect('reasoning' in result.message).toBe(false)
	})
})
