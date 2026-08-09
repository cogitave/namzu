import { describe, expect, it } from 'vitest'

import type { RunId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/events.js'
import { mapRunToStreamEvent } from './mapper.js'

/**
 * The cursor has to survive the wire, or the kernel sequences its events and
 * the surface a client actually reads drops the number — which is the shape of
 * a capability "complete except for the wire between its halves", and this
 * repository has shipped one of those before.
 */

const RID = 'run_1' as RunId

describe('the wire carries the cursor', () => {
	it('stamps <runId>:<seq> on a recorded event', () => {
		const mapped = mapRunToStreamEvent(
			{ type: 'iteration_started', runId: RID, iteration: 1, seq: 12 } as RunEvent,
			RID,
		)

		expect(mapped?.id).toBe('run_1:12')
	})

	it('keys on the event’s OWN run, not the stream it arrives on', () => {
		// A parent's stream carries its children's events, each numbered in the
		// child's log. Stamping the enclosing run here produces a cursor that
		// addresses the wrong sequence — and it looks right.
		const child = 'run_child' as RunId

		const mapped = mapRunToStreamEvent(
			{ type: 'iteration_started', runId: child, iteration: 1, seq: 3 } as RunEvent,
			RID,
		)

		expect(mapped?.id).toBe('run_child:3')
	})

	it('leaves the id off an event that is not recoverable', () => {
		// A delta is never persisted, so an id on it would be a cursor pointing
		// at a sequence the log has never heard of. A client that advanced onto
		// it and reconnected would be told it is ahead of the run.
		const mapped = mapRunToStreamEvent(
			{
				type: 'text_delta',
				runId: RID,
				iteration: 1,
				messageId: 'm1',
				text: 'x',
			} as unknown as RunEvent,
			RID,
		)

		expect(mapped?.wire).toBe('message.delta')
		expect(mapped?.id).toBeUndefined()
	})

	it('leaves the id off an event whose durable write failed', () => {
		// Same envelope shape as an ephemeral one, and the same meaning: no seq,
		// no cursor.
		const mapped = mapRunToStreamEvent(
			{ type: 'run_paused', runId: RID, checkpointId: 'cp_1', reason: 'review' } as RunEvent,
			RID,
		)

		expect(mapped?.wire).toBe('run.paused')
		expect(mapped?.id).toBeUndefined()
	})
})
