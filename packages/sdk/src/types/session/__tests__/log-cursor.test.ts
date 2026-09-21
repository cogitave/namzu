import { describe, expect, it } from 'vitest'

import type { SessionLogHead } from '../../../store/session-log/index.js'
import { resolveSessionLogReplay } from '../log-cursor.js'
import type { SessionRecord } from '../records.js'

/**
 * The verdict is the whole point of the cursor.
 *
 * A consumer that asks for everything after seq N and silently receives a
 * SHORT answer folds a hole into its state and cannot tell. So every branch
 * here is a refusal that has to fire, and the assertion is always "nothing was
 * handed over" as well as "the reason says why".
 */

const record = (seq: number): SessionRecord =>
	({
		v: 1,
		type: 'iteration_started',
		id: '0198cc93-582e-7cfb-8511-73bd81e1ed21',
		sessionId: '37ddff8e-e13f-4e57-937f-d048fa323f5e',
		seq,
		ts: '2026-09-21T00:00:00.000Z',
		prev: null,
		gen: 1,
		iteration: seq,
	}) as never

const head = (seq: number, gen = 1): SessionLogHead => ({
	pointer: { seq, offset: 0, length: 1, sha256: '0'.repeat(64) },
	gen,
	bytes: 1,
})

describe('what a cursor is owed', () => {
	it('reports complete when the cursor is already at the head', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 7 }, head(7), [])).toEqual({ status: 'complete' })
	})

	it('reports complete for an empty log and a consumer that has seen nothing', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 0 }, null, [])).toEqual({ status: 'complete' })
	})

	it('hands back exactly the records above the cursor', () => {
		const replay = resolveSessionLogReplay({ sinceSeq: 7 }, head(9), [record(8), record(9)])
		expect(replay.status).toBe('replayed')
		if (replay.status !== 'replayed') return
		expect(replay.records.map((r) => r.seq)).toEqual([8, 9])
	})
})

describe('it refuses rather than delivering a partial catch-up', () => {
	it('calls a cursor above the log ahead, not up to date', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 400 }, null, [])).toEqual({
			status: 'unavailable',
			reason: 'cursor_ahead',
		})
	})

	it('refuses a cursor from an older lease generation, and delivers nothing', () => {
		const replay = resolveSessionLogReplay({ sinceSeq: 400, generation: 4 }, head(402, 9), [
			record(401),
			record(402),
		])
		expect(replay).toEqual({ status: 'unavailable', reason: 'generation_changed' })
		expect(replay).not.toHaveProperty('records')
	})

	it('checks the generation BEFORE the sequence', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 5, generation: 1 }, head(5, 2), [])).toEqual({
			status: 'unavailable',
			reason: 'generation_changed',
		})
	})

	it('names a gap when the records start above the next expected seq', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 7 }, head(14), [record(12), record(13)])).toEqual({
			status: 'unavailable',
			reason: 'gap',
		})
	})

	it('names a gap when the head says there is more and nothing was read', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 3 }, head(9), [])).toEqual({
			status: 'unavailable',
			reason: 'gap',
		})
	})
})

describe('a cursor without a generation is not a mismatched one', () => {
	it('replays when the consumer tracked no generation', () => {
		expect(resolveSessionLogReplay({ sinceSeq: 1 }, head(2, 3), [record(2)]).status).toBe(
			'replayed',
		)
	})

	it('replays when the generation is unchanged', () => {
		expect(
			resolveSessionLogReplay({ sinceSeq: 1, generation: 4 }, head(2, 4), [record(2)]).status,
		).toBe('replayed')
	})
})
