import { describe, expect, it } from 'vitest'

import type { StreamChunk } from '../../types/provider/index.js'
import { collectChatCompletion } from '../collect-chat-completion.js'
import {
	ToolCallIndexer,
	describeToolCallFramingViolation,
	describeToolCallInterleaving,
	isUnindexedFragment,
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

describe('isUnindexedFragment', () => {
	it('is true only with neither an index nor an id', () => {
		expect(isUnindexedFragment({})).toBe(true)
		expect(isUnindexedFragment({ id: 'a' })).toBe(false)
		expect(isUnindexedFragment({ index: 0 })).toBe(false)
		expect(isUnindexedFragment({ index: 0, id: 'a' })).toBe(false)
	})
})

describe('ToolCallIndexer.placeUnindexedFragment', () => {
	it('starts the first call when nothing has opened yet', () => {
		const indexer = new ToolCallIndexer()
		// `canAccept` is never asked: there is nothing open to ask about.
		expect(indexer.placeUnindexedFragment(() => false)).toBe(0)
	})

	it('continues the one open call that can still accept text', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		expect(indexer.placeUnindexedFragment((i) => i === 0)).toBe(0)
	})

	it('names every candidate, and places the fragment on none of them, when more than one open call can still accept', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		indexer.indexOf({ id: 'b' })
		// Both still empty: the ordinary "open, open, THEN arguments interleave"
		// shape, which the old "check once when the second call opens" design
		// missed because empty was read as already complete.
		expect(indexer.placeUnindexedFragment(() => true)).toEqual({
			candidates: [
				{ index: 0, id: 'a' },
				{ index: 1, id: 'b' },
			],
		})
	})

	it('names no candidate when no open call can still accept', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		expect(indexer.placeUnindexedFragment(() => false)).toEqual({ candidates: [] })
	})

	it('picks the one call that can accept among several that cannot', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		indexer.indexOf({ id: 'b' })
		indexer.indexOf({ id: 'c' })
		expect(indexer.placeUnindexedFragment((i) => i === 2)).toBe(2)
	})

	it('is evaluated fresh each time, not decided once when a call opened', () => {
		const indexer = new ToolCallIndexer()
		indexer.indexOf({ id: 'a' })
		indexer.indexOf({ id: 'b' })
		// While both can still accept, a fragment is ambiguous...
		expect(indexer.placeUnindexedFragment(() => true)).toEqual({
			candidates: [
				{ index: 0, id: 'a' },
				{ index: 1, id: 'b' },
			],
		})
		// ...but once only one can (its caller having since completed the
		// other), the very same indexer places the next one unambiguously.
		expect(indexer.placeUnindexedFragment((i) => i === 1)).toBe(1)
	})

	it('names an as-yet-unnamed candidate by index, not by a made-up id', () => {
		const indexer = new ToolCallIndexer()
		// Arguments before any id at all: an anonymous open call. A SEPARATE
		// call with its own explicit index, unlike one merely named by a
		// later id-less-and-index-less id, leaves the first one unnamed.
		indexer.placeUnindexedFragment(() => false)
		indexer.indexOf({ index: 1, id: 'b' })
		expect(indexer.placeUnindexedFragment(() => true)).toEqual({
			candidates: [
				{ index: 0, id: undefined },
				{ index: 1, id: 'b' },
			],
		})
	})

	it('describes an ambiguous fragment and an orphaned one in one sentence each', () => {
		expect(
			describeToolCallInterleaving({
				kind: 'interleaved_without_index',
				candidates: [
					{ index: 0, id: 'a' },
					{ index: 1, id: 'b' },
				],
			}),
		).toBe(
			'the stream sent a tool-call fragment with neither an index nor an id while "a" and "b" could each still have accepted it, with nothing to tell them apart',
		)
		expect(
			describeToolCallInterleaving({ kind: 'interleaved_without_index', candidates: [] }),
		).toContain('no open call could still have accepted it')
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

	it('reports both calls unreadable when both open empty, back to back, before either streams any argument text', async () => {
		// The usual chat-completions wire shape: id+name with EMPTY arguments,
		// for one call right after another, before either has streamed any
		// argument text. The gap: a check made once, when "b" opens, reading
		// "a"'s empty buffer as already complete, let this exact shape through.
		// The fix asks fresh, for every id-less fragment, which open calls
		// could still accept it right now — and an empty buffer can.
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({ id: 'call_a', type: 'function', function: { name: 'write', arguments: '' } }),
				unindexed({ id: 'call_b', type: 'function', function: { name: 'write', arguments: '' } }),
				unindexed({ function: { arguments: '{"path":"a.md","content":"AAAA"}' } }),
				unindexed({ function: { arguments: '{"path":"b.md","content":"BBBB"}' } }),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		const calls = response.message.toolCalls ?? []
		expect(calls.map((call) => call.id)).toEqual(['call_a', 'call_b'])
		for (const call of calls) {
			expect(call.function.arguments).toBe('{}')
			expect(call.metadata?.inputTruncated).toBe(true)
			expect(call.metadata?.inputError?.reason).toBe('malformed')
		}
		// Neither ambiguous fragment was guessed onto either call.
		expect(calls[0]?.metadata?.partialArguments).toBe('')
		expect(calls[1]?.metadata?.partialArguments).toBe('')
	})

	it('reports both unreadable when one call opens with its arguments already in the opening fragment', async () => {
		// "b" is not empty when it opens — its own opening fragment already
		// carries (incomplete) argument text — but it can still accept more,
		// same as an empty one, so this is just as ambiguous.
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({ id: 'call_a', type: 'function', function: { name: 'write', arguments: '' } }),
				unindexed({
					id: 'call_b',
					type: 'function',
					function: { name: 'write', arguments: '{"path":"b.md","content":"' },
				}),
				unindexed({ function: { arguments: 'ambiguous"}' } }),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		const calls = response.message.toolCalls ?? []
		expect(calls.map((call) => call.id)).toEqual(['call_a', 'call_b'])
		for (const call of calls) {
			expect(call.function.arguments).toBe('{}')
			expect(call.metadata?.inputError?.reason).toBe('malformed')
		}
	})

	it('attributes an id-less continuation to the one call whose arguments are not yet complete', async () => {
		// "a" arrives complete in its own opening fragment. Only "b" can still
		// accept an id-less continuation, so it is unambiguous and "a" is
		// never touched or flagged.
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({
					id: 'call_a',
					type: 'function',
					function: { name: 'write', arguments: '{"path":"a.md","content":"x"}' },
				}),
				unindexed({ id: 'call_b', type: 'function', function: { name: 'write', arguments: '' } }),
				unindexed({ function: { arguments: '{"path":"b.md","content":"y"}' } }),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		const calls = response.message.toolCalls ?? []
		expect(
			calls.map((call) => [call.id, call.function.arguments, call.metadata?.inputTruncated]),
		).toEqual([
			['call_a', '{"path":"a.md","content":"x"}', undefined],
			['call_b', '{"path":"b.md","content":"y"}', undefined],
		])
	})

	it('leaves a lone empty-argument call clean when no further fragment ever arrives for it', async () => {
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({
					id: 'call_x',
					type: 'function',
					function: { name: 'list_files', arguments: '' },
				}),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		// `collectChatCompletion` returns the raw accumulated buffer, empty
		// here, never `{}`; that normalization is `parseToolArguments`'s job
		// downstream, not this helper's.
		expect(response.message.toolCalls).toEqual([
			{ id: 'call_x', type: 'function', function: { name: 'list_files', arguments: '' } },
		])
	})

	it('attributes an id-less fragment to the one call, among three, that can still accept it', async () => {
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({
					id: 'call_a',
					type: 'function',
					function: { name: 'write', arguments: '{"a":1}' },
				}),
				unindexed({
					id: 'call_b',
					type: 'function',
					function: { name: 'write', arguments: '{"b":2}' },
				}),
				unindexed({ id: 'call_c', type: 'function', function: { name: 'write', arguments: '' } }),
				unindexed({ function: { arguments: '{"c":3}' } }),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		expect(
			response.message.toolCalls?.map((call) => [call.id, call.function.arguments, call.metadata]),
		).toEqual([
			['call_a', '{"a":1}', undefined],
			['call_b', '{"b":2}', undefined],
			['call_c', '{"c":3}', undefined],
		])
	})

	it('leaves an empty-argument tool immediately followed by another, self-contained call, untouched', async () => {
		const unindexed = (fragment: Record<string, unknown>): StreamChunk =>
			({ id: 'r', delta: { toolCalls: [fragment] } }) as unknown as StreamChunk
		const response = await collectChatCompletion(
			chunks(
				unindexed({
					id: 'call_x',
					type: 'function',
					function: { name: 'list_files', arguments: '' },
				}),
				unindexed({
					id: 'call_y',
					type: 'function',
					function: { name: 'read', arguments: '{"path":"c.md"}' },
				}),
				{ id: 'r', delta: {}, finishReason: 'tool_calls' },
			),
		)
		expect(response.message.toolCalls?.map((call) => [call.id, call.function.arguments])).toEqual([
			['call_x', ''],
			['call_y', '{"path":"c.md"}'],
		])
		expect(response.message.toolCalls?.every((call) => call.metadata === undefined)).toBe(true)
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
