import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../../types/provider/index.js'
import { collectChatCompletion } from '../collect-chat-completion.js'
import { describeToolCallFramingViolation, toolCallFramingViolation } from '../tool-call-framing.js'

/**
 * Two calls on one index had their arguments joined. Both aggregators now
 * refuse that stream, in the same words. Arguments before a call's id were
 * dropped in the turn loop and kept here; both keep them now, since the index
 * says whose they are.
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

	it('accepts the same id again, an id arriving with the arguments, and arguments before the id', () => {
		expect(toolCallFramingViolation({ id: 'a' }, { index: 0, id: 'a' })).toBeUndefined()
		expect(
			toolCallFramingViolation(undefined, { index: 0, function: { arguments: '{' } }),
		).toBeUndefined()
		expect(
			toolCallFramingViolation({ id: '' }, { index: 0, function: { arguments: '{' } }),
		).toBeUndefined()
		expect(
			toolCallFramingViolation(undefined, { index: 0, id: 'a', function: { arguments: '{' } }),
		).toBeUndefined()
		expect(
			toolCallFramingViolation(undefined, { index: 0, function: { name: 'read' } }),
		).toBeUndefined()
	})

	it('describes the violation in one sentence', () => {
		expect(
			describeToolCallFramingViolation({ kind: 'index_reused', index: 1, openId: 'a', newId: 'b' }),
		).toBe('the stream reused tool-call index 1 for call "b" while call "a" held it')
	})
})

describe('collectChatCompletion and tool-call framing', () => {
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

	it('keeps arguments sent before the id, and fills the id in when it arrives', async () => {
		// What it did before the framing check was added; refusing it turned a
		// response it assembled correctly into an error.
		const response = await collectChatCompletion(
			chunks(
				{
					id: 'r',
					delta: { toolCalls: [{ index: 0, function: { name: 'x', arguments: '{"a":' } }] },
				},
				{
					id: 'r',
					delta: { toolCalls: [{ index: 0, id: 'call_1', function: { arguments: '1}' } }] },
				},
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		expect(response.finishReason).toBe('tool_calls')
		expect(
			response.message.toolCalls?.map((call) => [
				call.id,
				call.function.name,
				call.function.arguments,
			]),
		).toEqual([['call_1', 'x', '{"a":1}']])
	})

	it('places fragments sent with no index by their ids', async () => {
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				// Arguments before the id, with no index either: the id names
				// the call they started.
				unindexed({ function: { name: 'read', arguments: '{"path":' } }),
				unindexed({ id: 'call_a', function: { arguments: '"a.md"}' } }),
				unindexed({ id: 'call_b', type: 'function', function: { name: 'read', arguments: '' } }),
				unindexed({ function: { arguments: '{"path":"b.md"}' } }),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		expect(response.message.toolCalls?.map((call) => [call.id, call.function.arguments])).toEqual([
			['call_a', '{"path":"a.md"}'],
			['call_b', '{"path":"b.md"}'],
		])
	})

	it('still refuses a reused index a fragment does carry', async () => {
		await expect(
			collectChatCompletion(
				chunks(
					{ id: 'r', delta: { toolCalls: [{ index: 0, id: 'a', function: { name: 'x' } }] } },
					{ id: 'r', delta: { toolCalls: [{ index: 0, id: 'b', function: { name: 'y' } }] } },
				),
			),
		).rejects.toThrow('reused tool-call index 0')
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
