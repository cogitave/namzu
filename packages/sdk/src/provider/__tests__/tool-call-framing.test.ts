import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../../types/provider/index.js'
import { collectChatCompletion } from '../collect-chat-completion.js'
import { describeToolCallFramingViolation, toolCallFramingViolation } from '../tool-call-framing.js'

/**
 * Two calls on one index had their arguments joined, and arguments before a
 * call's id were dropped in the turn loop and kept here. Both aggregators now
 * refuse the stream, in the same words.
 */

async function* chunks(...list: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of list) yield chunk
}

describe('toolCallFramingViolation', () => {
	it('names a second id on an index another call holds', () => {
		expect(toolCallFramingViolation({ id: 'a' }, { index: 2, id: 'b' })).toEqual({
			kind: 'index_reused',
			index: 2,
			openId: 'a',
			newId: 'b',
		})
	})

	it('names arguments that arrive before any id', () => {
		expect(toolCallFramingViolation(undefined, { index: 0, function: { arguments: '{' } })).toEqual(
			{ kind: 'fragment_before_id', index: 0 },
		)
		expect(
			toolCallFramingViolation({ id: '' }, { index: 0, function: { arguments: '{' } }),
		).toEqual({ kind: 'fragment_before_id', index: 0 })
	})

	it('accepts the same id again, an id arriving with the arguments, and a name before the id', () => {
		expect(toolCallFramingViolation({ id: 'a' }, { index: 0, id: 'a' })).toBeUndefined()
		expect(
			toolCallFramingViolation(undefined, { index: 0, id: 'a', function: { arguments: '{' } }),
		).toBeUndefined()
		expect(
			toolCallFramingViolation(undefined, { index: 0, function: { name: 'read' } }),
		).toBeUndefined()
	})

	it('describes each violation in one sentence', () => {
		expect(
			describeToolCallFramingViolation({ kind: 'index_reused', index: 1, openId: 'a', newId: 'b' }),
		).toBe('the stream reused tool-call index 1 for call "b" while call "a" held it')
		expect(describeToolCallFramingViolation({ kind: 'fragment_before_id', index: 3 })).toBe(
			"the stream sent arguments for tool-call index 3 before naming the call's id",
		)
	})
})

describe('collectChatCompletion refuses a stream that breaks the framing', () => {
	it('does not join two calls that share an index', async () => {
		await expect(
			collectChatCompletion(
				chunks(
					{
						id: 'r',
						delta: { toolCalls: [{ index: 0, id: 'a', function: { name: 'x', arguments: '{}' } }] },
					},
					{
						id: 'r',
						delta: { toolCalls: [{ index: 0, id: 'b', function: { name: 'y', arguments: '{}' } }] },
					},
				),
			),
		).rejects.toThrow(
			'Provider stream error: the stream reused tool-call index 0 for call "b" while call "a" held it',
		)
	})

	it('does not keep arguments sent before the id', async () => {
		await expect(
			collectChatCompletion(
				chunks(
					{ id: 'r', delta: { toolCalls: [{ index: 0, function: { arguments: '{"a":1}' } }] } },
					{ id: 'r', delta: { toolCalls: [{ index: 0, id: 'a', function: { name: 'x' } }] } },
				),
			),
		).rejects.toThrow("before naming the call's id")
	})

	it('still assembles well-framed parallel calls', async () => {
		const response = await collectChatCompletion(
			chunks(
				{ id: 'r', delta: { toolCalls: [{ index: 0, id: 'a', function: { name: 'x' } }] } },
				{ id: 'r', delta: { toolCalls: [{ index: 1, id: 'b', function: { name: 'y' } }] } },
				{ id: 'r', delta: { toolCalls: [{ index: 0, function: { arguments: '{"n":1}' } }] } },
				{ id: 'r', delta: { toolCalls: [{ index: 1, id: 'b', function: { arguments: '{}' } }] } },
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		expect(response.message.toolCalls?.map((call) => [call.id, call.function.arguments])).toEqual([
			['a', '{"n":1}'],
			['b', '{}'],
		])
	})
})
