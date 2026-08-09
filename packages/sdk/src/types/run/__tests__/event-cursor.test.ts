import { describe, expect, it } from 'vitest'

import { resolveRunEventReplay } from '../event-cursor.js'
import type { PersistedRunEvent } from '../events.js'

/**
 * The verdict is the whole point of the cursor.
 *
 * A consumer that asks for everything after sequence N and silently receives a
 * SHORT answer folds a hole into its state and cannot tell. So every branch
 * here is a refusal that has to fire, and the assertion is always "nothing was
 * handed over" as well as "the reason says why" — a status string beside a
 * delivered array would be the same defect wearing a label.
 */

const event = (seq: number): PersistedRunEvent =>
	({ type: 'iteration_started', runId: 'run_1', iteration: seq, seq, timestamp: 1 }) as never

describe('what a cursor is owed', () => {
	it('reports complete when the cursor is already at the head', () => {
		expect(resolveRunEventReplay({ sinceSeq: 7 }, { lastSeq: 7 }, [])).toEqual({
			status: 'complete',
		})
	})

	it('hands back exactly the events above the cursor', () => {
		const missed = [event(8), event(9)]

		const replay = resolveRunEventReplay({ sinceSeq: 7 }, { lastSeq: 9 }, missed)

		expect(replay.status).toBe('replayed')
		if (replay.status !== 'replayed') return
		// Contiguous from sinceSeq + 1: the event the consumer already has must
		// not come back, and the one after it must.
		expect(replay.events.map((e) => e.seq)).toEqual([8, 9])
	})

	it('replays from the beginning for a consumer that has seen nothing', () => {
		const replay = resolveRunEventReplay({ sinceSeq: 0 }, { lastSeq: 2 }, [event(1), event(2)])

		expect(replay.status).toBe('replayed')
		if (replay.status !== 'replayed') return
		expect(replay.events.map((e) => e.seq)).toEqual([1, 2])
	})
})

describe('it refuses rather than delivering a partial catch-up', () => {
	it('calls a cursor above the log ahead, not up to date', () => {
		// This is what a LOST log looks like from the outside: an in-memory run
		// store on a restarted process seeds at zero while the consumer still
		// holds 400. Reporting `complete` here would tell it, serenely, that it
		// has the whole run.
		const replay = resolveRunEventReplay({ sinceSeq: 400 }, { lastSeq: 0 }, [])

		expect(replay).toEqual({ status: 'unavailable', reason: 'cursor_ahead' })
	})

	it('refuses a cursor minted under an older generation, and delivers nothing', () => {
		// The dangerous shape: the numbers line up perfectly. Sequence 400 exists
		// under generation 9 and means something entirely different from the
		// consumer's 400 under generation 4.
		const missed = [event(401), event(402)]

		const replay = resolveRunEventReplay(
			{ sinceSeq: 400, generation: 4 },
			{ lastSeq: 402, generation: 9 },
			missed,
		)

		expect(replay).toEqual({ status: 'unavailable', reason: 'generation_changed' })
		// Asserted separately and deliberately: the refusal is worth nothing if
		// the events ride along with it.
		expect(replay).not.toHaveProperty('events')
	})

	it('checks the generation BEFORE the sequence, so a takeover is not read as caught up', () => {
		// Equal sequences under different generations. If the order were the
		// other way round this returns `complete` — the worst possible answer,
		// because the consumer stops asking.
		const replay = resolveRunEventReplay(
			{ sinceSeq: 5, generation: 1 },
			{ lastSeq: 5, generation: 2 },
			[],
		)

		expect(replay).toEqual({ status: 'unavailable', reason: 'generation_changed' })
	})

	it('names a gap when the store answers above the next expected sequence', () => {
		// A pruning or windowed backend. Delivering 12 onward to a consumer that
		// asked from 8 is a continuous-looking stream with three events missing
		// out of the middle of it.
		const replay = resolveRunEventReplay({ sinceSeq: 7 }, { lastSeq: 14 }, [event(12), event(13)])

		expect(replay).toEqual({ status: 'unavailable', reason: 'gap' })
	})

	it('names a gap when the head says there is more and the store returns nothing', () => {
		const replay = resolveRunEventReplay({ sinceSeq: 3 }, { lastSeq: 9 }, [])

		expect(replay).toEqual({ status: 'unavailable', reason: 'gap' })
	})
})

describe('an unfenced run is not a mismatched one', () => {
	it('replays when neither side carries a generation', () => {
		// Most runs take no claim. Treating "absent" as a value that disagrees
		// with itself would refuse every one of them.
		const replay = resolveRunEventReplay({ sinceSeq: 1 }, { lastSeq: 2 }, [event(2)])

		expect(replay.status).toBe('replayed')
	})

	it('replays when only one side carries a generation', () => {
		// A consumer that connected before the run was claimed, or a run claimed
		// after the consumer attached. Neither is evidence of a takeover, and the
		// sequence is still the log's own.
		expect(
			resolveRunEventReplay({ sinceSeq: 1 }, { lastSeq: 2, generation: 3 }, [event(2)]).status,
		).toBe('replayed')
		expect(
			resolveRunEventReplay({ sinceSeq: 1, generation: 3 }, { lastSeq: 2 }, [event(2)]).status,
		).toBe('replayed')
	})

	it('replays when the generation is unchanged', () => {
		const replay = resolveRunEventReplay(
			{ sinceSeq: 1, generation: 4 },
			{ lastSeq: 2, generation: 4 },
			[event(2)],
		)

		expect(replay.status).toBe('replayed')
	})
})
