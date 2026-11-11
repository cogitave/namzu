import { describe, expect, it } from 'vitest'
import { checkpointLogView } from '../../../runtime/query/session-storage.js'
import type { CheckpointId } from '../../../types/ids/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import type { SessionLog } from '../../session-log/index.js'
import type { CheckpointLogView, CheckpointScope } from '../contract.js'
import { selectStoredCheckpointsToPrune } from '../prune.js'

/**
 * Choosing what to prune asked the log one full walk per stored checkpoint
 * plus one for the open decisions, on every iteration of every turn. A
 * session's log only grows, so the cost of each turn grew with it. The
 * walks are counted here, never timed.
 */

const SCOPE = { sessionId: 's1', turnId: 't1' } as unknown as CheckpointScope

function id(n: number): CheckpointId {
	return `cp-${String(n).padStart(4, '0')}` as CheckpointId
}

function stored(n: number): Checkpoint[] {
	return Array.from({ length: n }, (_, i) => ({
		checkpointId: id(i),
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	})) as unknown as Checkpoint[]
}

/** A log of `records` that counts how many walks were started and how many entries they yielded. */
function countingLog(records: readonly Record<string, unknown>[]) {
	const counts = { walks: 0, entries: 0 }
	const log = {
		sessionId: 's1',
		async *read() {
			counts.walks++
			for (const [i, record] of records.entries()) {
				counts.entries++
				yield { record, pointer: { seq: i + 1, sha256: 'x' } }
			}
		},
	} as unknown as SessionLog
	return { log, counts }
}

function recordsFor(committed: readonly number[], open: readonly [string, number][] = []) {
	return [
		...committed.map((n) => ({
			type: 'checkpoint_written',
			checkpointId: id(n),
			docSha256: `sha-${n}`,
		})),
		...open.map(([decisionId, n]) => ({
			type: 'decision_requested',
			decisionId,
			checkpointId: id(n),
		})),
	]
}

/** The same view with the batch method removed: what a view written before it does. */
function withoutBatch(view: CheckpointLogView): CheckpointLogView {
	return {
		verifyThrough: view.verifyThrough.bind(view),
		writtenDocSha256: view.writtenDocSha256.bind(view),
		openDecisionCheckpoints: view.openDecisionCheckpoints.bind(view),
	}
}

describe('choosing the checkpoints to prune', () => {
	it('walks the log once however many checkpoints are stored', async () => {
		const walks: number[] = []
		for (const n of [5, 20, 80]) {
			const { log, counts } = countingLog(recordsFor(Array.from({ length: n }, (_, i) => i)))
			await selectStoredCheckpointsToPrune(checkpointLogView(log), SCOPE, stored(n), 3)
			walks.push(counts.walks)
		}
		expect(walks).toEqual([1, 1, 1])
	})

	it('a view without the batch method still works, at one walk per checkpoint', async () => {
		const { log, counts } = countingLog(recordsFor([0, 1, 2, 3]))
		await selectStoredCheckpointsToPrune(withoutBatch(checkpointLogView(log)), SCOPE, stored(4), 1)
		expect(counts.walks).toBe(4 + 1)
	})

	it('chooses the same checkpoints as the separate questions', async () => {
		// 0..9 stored; 2 and 6 never committed; 1 is named by an open decision,
		// 4 by one that was later resolved.
		const records = [
			...recordsFor(
				[0, 1, 3, 4, 5, 7, 8, 9],
				[
					['d1', 1],
					['d2', 4],
				],
			),
			{ type: 'decision_resolved', decisionId: 'd2' },
		]
		const batch = await selectStoredCheckpointsToPrune(
			checkpointLogView(countingLog(records).log),
			SCOPE,
			stored(10),
			3,
		)
		const separate = await selectStoredCheckpointsToPrune(
			withoutBatch(checkpointLogView(countingLog(records).log)),
			SCOPE,
			stored(10),
			3,
		)
		expect(batch).toEqual(separate)
		// Committed: 0 1 3 4 5 7 8 9; the newest three (7 8 9) stay; 1 is protected; 2 and 6 are untouched.
		expect(batch).toEqual([id(0), id(3), id(4), id(5)])
	})

	it('answers for another session with nothing committed', async () => {
		const view = checkpointLogView(countingLog(recordsFor([0])).log)
		await expect(
			view.pruneFacts?.({ sessionId: 'other', turnId: 't1' } as unknown as CheckpointScope, [
				id(0),
			]),
		).rejects.toThrow(/not other/)
	})
})
