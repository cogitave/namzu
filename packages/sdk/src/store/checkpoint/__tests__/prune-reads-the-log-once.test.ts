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

let sessions = 0

function id(n: number): CheckpointId {
	return `cp-${String(n).padStart(4, '0')}` as CheckpointId
}

function stored(n: number): Checkpoint[] {
	return Array.from({ length: n }, (_, i) => ({
		checkpointId: id(i),
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
	})) as unknown as Checkpoint[]
}

/**
 * A log of `records` that counts how many walks were started and how many
 * entries they yielded. It resumes after a pointer the way a real log does.
 * Every log is its own session: what a reduction remembers is kept by session.
 */
function countingLog(records: Record<string, unknown>[]) {
	const counts = { walks: 0, entries: 0 }
	const sessionId = `session-${++sessions}`
	const scope = { sessionId, turnId: 't1' } as unknown as CheckpointScope
	const log = {
		sessionId,
		async *read(options: { after?: { seq: number } } = {}) {
			counts.walks++
			let head: { seq: number; sha256: string } | null = null
			for (const [i, record] of records.entries()) {
				const pointer = { seq: i + 1, offset: i, length: 1, sha256: `sha-${i + 1}` }
				head = pointer
				if (options.after !== undefined && pointer.seq <= options.after.seq) continue
				counts.entries++
				yield { record, pointer }
			}
			return {
				intact: true,
				throughSeq: head?.seq ?? 0,
				head: head && { pointer: head, gen: 1, bytes: 0 },
				tornBytes: 0,
			}
		},
	} as unknown as SessionLog
	return { log, counts, scope, records }
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
			const { log, counts, scope } = countingLog(recordsFor(Array.from({ length: n }, (_, i) => i)))
			await selectStoredCheckpointsToPrune(checkpointLogView(log), scope, stored(n), 3)
			walks.push(counts.walks)
		}
		expect(walks).toEqual([1, 1, 1])
	})

	it('a view without the batch method still works, at one walk per checkpoint', async () => {
		const { log, counts, scope } = countingLog(recordsFor([0, 1, 2, 3]))
		await selectStoredCheckpointsToPrune(withoutBatch(checkpointLogView(log)), scope, stored(4), 1)
		expect(counts.walks).toBe(4 + 1)
	})

	it('reads only what was appended since the last prune, however long the log', async () => {
		const read: number[] = []
		for (const n of [10, 40]) {
			const committed = Array.from({ length: n }, (_, i) => i)
			const { log, counts, scope, records } = countingLog(recordsFor(committed))
			const view = checkpointLogView(log)
			await selectStoredCheckpointsToPrune(view, scope, stored(n), 3)
			expect(counts.entries).toBe(n)
			// Six more prunes, each after one more checkpoint was committed.
			for (let k = 0; k < 6; k++) {
				records.push(...recordsFor([n + k]))
				await selectStoredCheckpointsToPrune(view, scope, stored(n + k + 1), 3)
			}
			read.push(counts.entries - n)
		}
		// Six records appended in all, however many were already there.
		expect(read).toEqual([6, 6])
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
		const batch = countingLog(records)
		const separate = countingLog(records)
		const viaBatch = await selectStoredCheckpointsToPrune(
			checkpointLogView(batch.log),
			batch.scope,
			stored(10),
			3,
		)
		const viaSeparate = await selectStoredCheckpointsToPrune(
			withoutBatch(checkpointLogView(separate.log)),
			separate.scope,
			stored(10),
			3,
		)
		expect(viaBatch).toEqual(viaSeparate)
		// Committed: 0 1 3 4 5 7 8 9; the newest three (7 8 9) stay; 1 is protected; 2 and 6 are untouched.
		expect(viaBatch).toEqual([id(0), id(3), id(4), id(5)])
	})

	it('answers for another session with nothing committed', async () => {
		const { log } = countingLog(recordsFor([0]))
		const view = checkpointLogView(log)
		await expect(
			view.pruneFacts?.({ sessionId: 'other', turnId: 't1' } as unknown as CheckpointScope, [
				id(0),
			]),
		).rejects.toThrow(/not other/)
	})
})
