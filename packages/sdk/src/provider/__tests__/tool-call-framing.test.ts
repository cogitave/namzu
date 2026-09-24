import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../../types/provider/index.js'
import { collectChatCompletion } from '../collect-chat-completion.js'
import {
	ToolCallIndexer,
	describeToolCallFramingViolation,
	describeToolCallInterleaving,
	toolCallFramingViolation,
} from '../tool-call-framing.js'

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

describe('ToolCallIndexer.interleaving', () => {
	it('names the call left open when a new id opens while it is still incomplete', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		indexer.indexOf({ id: 'a' })

		expect(indexer.interleaving({ id: 'b' }, () => false)).toEqual({
			kind: 'interleaved_without_index',
			openIndex: 0,
			openId: 'a',
			newId: 'b',
		})
	})

	it('is undefined for the sequential case: a new id after the open call completes', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		indexer.indexOf({ id: 'a' })

		// `isComplete` reports the open call's buffer as a finished JSON
		// value, as it would be once "a" received its closing brace.
		expect(indexer.interleaving({ id: 'b' }, () => true)).toBeUndefined()
	})

	it('is undefined when the fragment carries its own index, repeats a known id, or names none', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		indexer.indexOf({ id: 'a' })

		expect(indexer.interleaving({ index: 1, id: 'b' }, () => false)).toBeUndefined()
		expect(indexer.interleaving({ id: 'a' }, () => false)).toBeUndefined()
		expect(indexer.interleaving({}, () => false)).toBeUndefined()
	})

	it('is undefined when the call most recently active has no id of its own yet', () => {
		const indexer = new ToolCallIndexer()
		// Arguments before an id, as `collectChatCompletion` keeps them: the
		// open call is not yet "named", so a later id continues IT rather
		// than opening a second one (existing behaviour, unaffected).
		indexer.indexOf({})

		expect(indexer.interleaving({ id: 'a' }, () => false)).toBeUndefined()
	})

	it('describes the interleaving in one sentence', () => {
		expect(
			describeToolCallInterleaving({
				kind: 'interleaved_without_index',
				openIndex: 0,
				openId: 'a',
				newId: 'b',
			}),
		).toContain('opened tool call "b"')
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

	it('reports both calls unreadable instead of splicing them when a second opens before the first is complete', async () => {
		// Real LLM decoding is linear, so a compliant server never does this;
		// shared code must not guess anyway. Sequence: open A, a partial
		// argument for A, open B (no index on either — the case
		// `ToolCallIndexer` cannot place on its own), then two more
		// fragments with no id and no index, which the old code always
		// dropped onto whichever call was "latest" (here, B).
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({ id: 'a', function: { name: 'write', arguments: '' } }),
				unindexed({ id: 'a', function: { arguments: '{"path":"a.md","content":"AAAA' } }),
				unindexed({ id: 'b', function: { name: 'write', arguments: '' } }),
				unindexed({ function: { arguments: 'BBBB"}' } }),
				unindexed({ function: { arguments: '{"path":"b.md","content":"CCCC"}' } }),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)

		const calls = response.message.toolCalls ?? []
		expect(calls.map((call) => call.id)).toEqual(['a', 'b'])
		for (const call of calls) {
			// Neither call is ever executed with content spliced from the
			// other: arguments are normalized to '{}', exactly like any other
			// unreadable call, never a buffer that might hold a fragment
			// meant for the other one.
			expect(call.function.arguments).toBe('{}')
			expect(call.metadata?.inputTruncated).toBe(true)
			expect(call.metadata?.inputError?.reason).toBe('malformed')
			expect(call.metadata?.inputError?.parseError).toMatch(/interleaved/)
		}
		// The raw buffers, kept for a repairer, show where the fragments
		// actually landed (both on "b", since it was "latest" throughout) —
		// but never a splice of the OTHER call's own path or marker text
		// into a call it was never sent for.
		const byId = new Map(calls.map((call) => [call.id, call]))
		expect(byId.get('a')?.metadata?.partialArguments).not.toMatch(/BBBB|b\.md|CCCC/)
		expect(byId.get('b')?.metadata?.partialArguments).not.toMatch(/AAAA|a\.md/)
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
