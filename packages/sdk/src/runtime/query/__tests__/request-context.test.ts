import { describe, expect, it } from 'vitest'
import { createSlidingWindowReducer } from '../../../compaction/reducer.js'
import { clearToolResult } from '../../../compaction/tool-result-editing.js'
import type { Message, ToolMessage } from '../../../types/message/index.js'
import { diffRequestContext, snapshotRequestContext } from '../request-context.js'

const file: ToolMessage = { role: 'tool', toolCallId: 'read-1', content: '1\timportant content' }
const history: Message[] = [
	{ role: 'user', content: 'Read file' },
	{
		role: 'assistant',
		content: null,
		toolCalls: [
			{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } },
		],
	},
	file,
	{ role: 'user', content: 'Continue' },
]

describe('request context inventory', () => {
	it('keeps unchanged evidence across turns without treating shifted positions as loss', () => {
		const before = snapshotRequestContext(history)
		const after = snapshotRequestContext([{ role: 'system', content: 'instructions' }, ...history])
		expect(diffRequestContext(before, after).removed).toEqual([])
		expect(diffRequestContext(before, after).added).toHaveLength(1)
		expect(JSON.stringify(before)).not.toContain('important content')
		expect(Object.isFrozen(before.parts[0])).toBe(true)
	})

	it('distinguishes a cleared result from the read call that remains in context', () => {
		const changed = history.map((m) => (m === file ? clearToolResult(file, 'read').message : m))
		const delta = diffRequestContext(
			snapshotRequestContext(history),
			snapshotRequestContext(changed),
		)
		expect(delta.removed).toEqual([expect.objectContaining({ kind: 'text', toolCallId: 'read-1' })])
		expect(delta.added).toHaveLength(1)
		expect(delta.added[0]?.digest).not.toBe(delta.removed[0]?.digest)
	})

	it('detects evidence dropped by the real sliding-window reducer', async () => {
		const reduced = await createSlidingWindowReducer({ keepRecentMessages: 1 })({
			messages: history,
			reason: 'threshold',
			estimatedTokens: 1000,
			contextWindowTokens: 1100,
			model: 'mock',
			keepRecentMessages: 1,
		})
		expect(reduced).toBeDefined()
		const delta = diffRequestContext(
			snapshotRequestContext(history),
			snapshotRequestContext(reduced!),
		)
		expect(delta.removed).toContainEqual(
			expect.objectContaining({ toolCallId: 'read-1', kind: 'text' }),
		)
		expect(delta.added).toEqual([])
	})

	it('counts repeated blocks and distinguishes failed results', () => {
		const before = snapshotRequestContext([file, file])
		expect(diffRequestContext(before, snapshotRequestContext([file])).removed).toHaveLength(1)
		const delta = diffRequestContext(
			snapshotRequestContext([file]),
			snapshotRequestContext([{ ...file, isError: true }]),
		)
		expect(delta.removed).toHaveLength(1)
		expect(delta.added[0]?.isError).toBe(true)
	})

	it('hashes rich content independently of object property insertion order', () => {
		const before = snapshotRequestContext([
			{
				role: 'tool',
				toolCallId: 'image',
				content: [{ type: 'image', data: 'AAAA', mediaType: 'image/png' }],
			},
		])
		const after = snapshotRequestContext([
			{
				role: 'tool',
				toolCallId: 'image',
				content: [{ mediaType: 'image/png', data: 'AAAA', type: 'image' }],
			},
		])
		expect(diffRequestContext(before, after)).toEqual({ added: [], removed: [] })
	})
})
