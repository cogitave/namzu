import { describe, expect, it } from 'vitest'

import type { SessionLog } from '../../../store/session-log/index.js'
import { readCallsThatNeverStarted } from '../calls-that-never-started.js'

function logOf(records: readonly Record<string, unknown>[]): SessionLog {
	return {
		async *read() {
			for (const record of records) yield { record }
		},
	} as unknown as SessionLog
}

const calls = (turnId: string, ...ids: string[]) => ({
	type: 'message',
	turnId,
	content: { role: 'assistant', toolCalls: ids.map((id) => ({ id })) },
})

describe('readCallsThatNeverStarted', () => {
	it('names the calls of a journaled turn that have no start', async () => {
		const found = await readCallsThatNeverStarted(
			logOf([
				calls('t1', 'a', 'b', 'c'),
				{ type: 'tool_review_requested', turnId: 't1', toolCalls: [{ id: 'a' }] },
				{ type: 'tool_executing', turnId: 't1', toolUseId: 'b' },
			]),
		)
		expect([...found].sort()).toEqual(['a', 'c'])
	})

	it('leaves a turn that journals nothing alone', async () => {
		const found = await readCallsThatNeverStarted(logOf([calls('t1', 'a')]))
		expect(found.size).toBe(0)
	})

	it('names nothing when every call started', async () => {
		const found = await readCallsThatNeverStarted(
			logOf([calls('t1', 'a'), { type: 'tool_executing', turnId: 't1', toolUseId: 'a' }]),
		)
		expect(found.size).toBe(0)
	})
})
