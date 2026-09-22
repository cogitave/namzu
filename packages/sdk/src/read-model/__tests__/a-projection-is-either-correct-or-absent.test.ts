import { describe, expect, it } from 'vitest'

import type { TurnId } from '../../types/ids/index.js'
import type { SessionRecord } from '../../types/session/index.js'
import {
	DuplicateEventError,
	EventGapError,
	type ReadModel,
	ReadModelCollisionError,
	ReadModelRegistry,
	UnknownReadModelError,
} from '../registry.js'
import {
	SESSION_STATUS_READ_MODEL_ID,
	type SessionStatusState,
	createSessionStatusReadModel,
} from '../session-status.js'

/**
 * A derived value maintained one event at a time.
 *
 * Everything derived from a turn was computed by scanning what was in hand
 * when somebody asked. That works while the turn fits in memory and stops
 * working the moment it does not: a caller wanting the status of a turn
 * whose history was compacted, or of a turn in another process, loads the
 * log and folds it, and every caller folds it slightly differently.
 *
 * The registry's refusals are what make this a property rather than a hope.
 * A duplicate double-counts anything a model accumulates; a gap produces a
 * state that LOOKS complete and describes a log the registry never saw.
 */

const TURN = '65c1072f-6e86-4e25-a53d-a412ecd23952' as TurnId

let seq = 0
const event = (type: string, over: Record<string, unknown> = {}): SessionRecord =>
	({
		type,
		turnId: TURN,
		seq: ++seq,
		ts: new Date(1_000 + seq).toISOString(),
		...(type === 'turn_completed' ? { settlement: { status: 'completed' } } : {}),
		...over,
	}) as unknown as SessionRecord

/** A park as the log records it, and its answer. */
const parked = (decisionId = 'd1', over: Record<string, unknown> = {}) =>
	event('decision_requested', {
		decisionId,
		checkpointId: '0197a3f0-0000-7000-8000-0000000000c1',
		request: { type: 'tool_review', toolCalls: [] },
		...over,
	})
const answered = (decisionId = 'd1') =>
	event('decision_resolved', { decisionId, decision: { action: 'approve_tools' } })

const reset = () => {
	seq = 0
}

/** Counts every event, so a duplicate is visible as a wrong number. */
const counter: ReadModel<number> = {
	id: 'counter',
	initial: () => 0,
	apply: (state) => state + 1,
}

describe('the registry refuses what it cannot fold correctly', () => {
	it('refuses an event it has already applied', () => {
		// A duplicate double-counts anything a model accumulates, and nothing
		// downstream can tell a doubled count from a real one.
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)
		const first = event('turn_started')
		registry.apply(first)

		expect(() => registry.apply(first)).toThrow(DuplicateEventError)
		expect(registry.get<number>('counter')).toBe(1)
	})

	it('refuses an event that skips one', () => {
		// A projection built across a gap is wrong in a way nothing reports.
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)
		registry.apply(event('turn_started'))
		const skipped = { ...event('iteration_started'), seq: 5 } as SessionRecord

		expect(() => registry.apply(skipped)).toThrow(EventGapError)
	})

	it('names the seq it expected, so a caller can go and get it', () => {
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)
		registry.apply(event('turn_started'))

		try {
			registry.apply({ ...event('x'), seq: 9 } as SessionRecord)
			throw new Error('expected a refusal')
		} catch (err) {
			expect((err as EventGapError).details).toEqual({ seq: 9, expected: 2 })
		}
	})

	it('reports how far it has folded', () => {
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)

		expect(registry.lastSeq).toBe(0)
		registry.apply(event('a'))
		registry.apply(event('b'))
		expect(registry.lastSeq).toBe(2)
	})

	it('leaves every state untouched when it refuses', () => {
		// A partial fold is the corruption the refusal exists to prevent, and
		// a registry that refused AFTER mutating half its models would be
		// worse than one that accepted.
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)
		registry.apply(event('a'))

		expect(() => registry.apply({ ...event('b'), seq: 7 } as SessionRecord)).toThrow()

		expect(registry.get<number>('counter')).toBe(1)
		expect(registry.lastSeq).toBe(1)
	})
})

describe('replay is the honest way to start over', () => {
	it('rebuilds from nothing, so a caller that lost its place gets a correct answer', () => {
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)
		const log = [event('a'), event('b'), event('c')]
		registry.apply(log[0] as SessionRecord)

		registry.replay(log)

		expect(registry.get<number>('counter')).toBe(3)
		expect(registry.lastSeq).toBe(3)
	})

	it('folds a log to the same state whether taken in one pass or many', () => {
		// The property that makes "incremental" mean anything: applying event
		// N+1 to the state after N must equal replaying 1..N+1.
		reset()
		const log = [event('turn_started'), parked(), answered(), event('turn_completed')]

		const incremental = new ReadModelRegistry()
		incremental.register(createSessionStatusReadModel({ now: () => 5_000 }))
		for (const e of log) incremental.apply(e)

		const replayed = new ReadModelRegistry()
		replayed.register(createSessionStatusReadModel({ now: () => 5_000 }))
		replayed.replay(log)

		expect(incremental.get<SessionStatusState>(SESSION_STATUS_READ_MODEL_ID)).toEqual(
			replayed.get<SessionStatusState>(SESSION_STATUS_READ_MODEL_ID),
		)
	})
})

describe('registration', () => {
	it('refuses a duplicate id rather than letting the second win', () => {
		const registry = new ReadModelRegistry()
		registry.register(counter)

		expect(() => registry.register(counter)).toThrow(ReadModelCollisionError)
	})

	it('throws for an id nobody registered', () => {
		expect(() => new ReadModelRegistry().get('nope')).toThrow(UnknownReadModelError)
	})

	it('answers whether it holds one', () => {
		const registry = new ReadModelRegistry()
		expect(registry.has('counter')).toBe(false)
		registry.register(counter)
		expect(registry.has('counter')).toBe(true)
	})

	it('advances every model from ONE seq, so two reads agree', () => {
		// A registry per model would let a caller read two projections
		// derived from different prefixes of the same log.
		reset()
		const registry = new ReadModelRegistry()
		registry.register(counter)
		registry.register({ ...counter, id: 'counter2' })
		registry.apply(event('a'))

		expect(registry.get<number>('counter')).toBe(registry.get<number>('counter2'))
	})
})

describe('the session status projection', () => {
	const project = (events: SessionRecord[], now = 5_000): SessionStatusState => {
		const registry = new ReadModelRegistry()
		registry.register(createSessionStatusReadModel({ now: () => now }))
		registry.replay(events)
		return registry.get<SessionStatusState>(SESSION_STATUS_READ_MODEL_ID)
	}

	it('says queued before anything happened', () => {
		reset()
		expect(project([]).status).toBe('queued')
	})

	it('follows the turn through to succeeded', () => {
		reset()
		expect(project([event('turn_started')]).status).toBe('running')
		reset()
		expect(project([event('turn_started'), event('turn_completed')]).status).toBe('succeeded')
	})

	it('says failed for a failed turn', () => {
		reset()
		expect(project([event('turn_started'), event('turn_failed')]).status).toBe('failed')
	})

	it('says a human is owed an answer while a decision is outstanding', () => {
		reset()
		expect(project([event('turn_started'), parked()]).status).toBe('awaiting_hitl')
	})

	it('says the decision waited too long once its deadline passed', () => {
		reset()
		expect(
			project(
				[event('turn_started'), parked('d1', { deadlineAt: new Date(4_000).toISOString() })],
				5_000,
			).status,
		).toBe('awaiting_hitl_resolution')
	})

	it('says cancelled for a turn that settled cancelled', () => {
		reset()
		expect(
			project([
				event('turn_started'),
				event('turn_completed', { settlement: { status: 'cancelled' } }),
			]).status,
		).toBe('cancelled')
	})

	it('stops saying so the moment the answer arrives', () => {
		// On the ANSWER, not on the next tool call. A turn that stayed
		// `awaiting_hitl` until it happened to do something else would show a
		// human as owed an answer they had already given.
		reset()
		expect(project([event('turn_started'), parked(), answered()]).status).toBe('running')
	})

	it('does the same when the park expires unanswered', () => {
		reset()
		expect(
			project([event('turn_started'), parked(), event('decision_expired', { decisionId: 'd1' })])
				.status,
		).toBe('running')
	})

	it('does NOT treat a pause as a park', () => {
		// A pause with no park is a turn that stopped for a reason this
		// projection cannot name, and inventing `awaiting_hitl` would report
		// a human as owing an answer nobody asked them for.
		reset()
		expect(project([event('turn_started'), event('turn_paused')]).status).toBe('running')
	})

	it('lets a terminal state beat an outstanding park', () => {
		// A turn that finished is not waiting for anyone, whatever a stale
		// park says — the rule `deriveTurnStatus` already owns, still owned by
		// it and not re-implemented here.
		reset()
		expect(project([event('turn_started'), parked(), event('turn_completed')]).status).toBe(
			'succeeded',
		)
	})

	it('ignores events that say nothing about status', () => {
		reset()
		const before = project([event('turn_started')])
		reset()
		const after = project([event('turn_started'), event('text_delta', { text: 'x' })])

		expect(after.status).toBe(before.status)
	})
})
