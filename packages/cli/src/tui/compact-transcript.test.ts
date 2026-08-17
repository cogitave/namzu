import { describe, expect, it } from 'vitest'

import { keepRecentRows } from './compact-transcript.js'
import type { TranscriptMessage } from './types.js'

/**
 * The transcript and the message list are not the same thing, and this is where
 * that stops being a detail.
 *
 * A compaction pass returns messages. The transcript also holds tool rows,
 * glyphs and collapsed bodies the model never saw, so the two cannot be lined
 * up by index — and rebuilding the transcript from the returned messages would
 * be correct about the conversation while erasing how the surviving turns
 * looked.
 */

function row(role: TranscriptMessage['role'], content: string): TranscriptMessage {
	return { id: `${role}-${content}`, role, content }
}

describe('keepRecentRows', () => {
	it('keeps the last N user/assistant turns', () => {
		const rows = [
			row('user', 'u1'),
			row('assistant', 'a1'),
			row('user', 'u2'),
			row('assistant', 'a2'),
		]
		expect(keepRecentRows(rows, 2).map((r) => r.content)).toEqual(['u2', 'a2'])
	})

	it('keeps the tool rows that belong to a surviving turn', () => {
		// The reason this counts rather than slices by message index. A kept
		// answer with its tool rows dropped is an answer on screen with no
		// visible cause.
		const rows = [
			row('user', 'u1'),
			row('assistant', 'a1'),
			row('user', 'u2'),
			row('tool', 'ran bash'),
			row('assistant', 'a2'),
		]
		expect(keepRecentRows(rows, 2).map((r) => r.content)).toEqual(['u2', 'ran bash', 'a2'])
	})

	it('is not confused by rows the model never saw at the front', () => {
		// System rows, an earlier compaction summary, a `/status` readout —
		// none were sent, and any index computed from the front is off by
		// however many of them exist. Counting from the end is immune.
		const rows = [
			row('system', 'a previous summary'),
			row('system', 'a /status readout'),
			row('user', 'u1'),
			row('assistant', 'a1'),
		]
		expect(keepRecentRows(rows, 2).map((r) => r.content)).toEqual(['u1', 'a1'])
	})

	it('keeps everything when the pass kept more turns than exist', () => {
		const rows = [row('user', 'u1'), row('assistant', 'a1')]
		expect(keepRecentRows(rows, 10)).toHaveLength(2)
	})

	it('keeps nothing when the pass kept nothing', () => {
		// Guarded explicitly: falling through to the loop returns the WHOLE
		// transcript for a zero, which is the opposite of what was asked and
		// would look like compaction had done nothing.
		const rows = [row('user', 'u1'), row('assistant', 'a1')]
		expect(keepRecentRows(rows, 0)).toEqual([])
		expect(keepRecentRows(rows, -1)).toEqual([])
	})

	it('handles an empty transcript', () => {
		expect(keepRecentRows([], 3)).toEqual([])
	})
})
