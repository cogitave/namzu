/**
 * Behavioural contract for `collect()` (ses_001-tool-stream-events phase 1A):
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
 *   (defensive — see anthropics/anthropic-sdk-typescript#842).
 * - Throws if any chunk surfaces a `chunk.error`.
 *
 * Phase 2 swaps every internal `provider.chat()` call site for
 * `collect(provider.chatStream())`; the response shape parity guarded
 * here is what makes that swap safe.
 */

import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../types/provider/stream.js'

import { collect } from './collect.js'

async function* fromArray(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) yield chunk
}

describe('collect()', () => {
	it('aggregates text-only stream into single content string', async () => {
		const result = await collect(
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
		const result = await collect(fromArray([{ id: 'm', delta: {}, finishReason: 'stop' }]))
		expect(result.message.content).toBeNull()
	})

	it('buckets parallel tool calls by index, preserves order', async () => {
		const result = await collect(
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
		const result = await collect(
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
		const result = await collect(fromArray([{ id: 'm', delta: { content: 'hi' } }]))
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
			collect(
				fromArray([
					{ id: 'm', delta: { content: 'hi' } },
					{ id: 'm', delta: {}, error: 'rate limited' },
				]),
			),
		).rejects.toThrow('rate limited')
	})
})
