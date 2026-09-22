import { describe, expect, it } from 'vitest'

import { fixtureId } from '../../test-support/ids.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { SessionEvent } from '../../types/session/events.js'
import { mapSessionEventToStreamEvent } from './mapper.js'

/**
 * The cursor has to survive the wire, or the kernel sequences its events and
 * the surface a client actually reads drops the number — which is the shape of
 * a capability "complete except for the wire between its halves", and this
 * repository has shipped one of those before.
 */

const SID = '37ddff8e-e13f-4e57-937f-d048fa323f5e' as SessionId
const TID = '0199b3a0-0000-7000-8000-00000000000a' as TurnId

describe('the wire carries the cursor', () => {
	it('stamps <sessionId>:<seq> on a recorded event', () => {
		const mapped = mapSessionEventToStreamEvent({
			type: 'iteration_started',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			seq: 12,
		} as SessionEvent)

		expect(mapped?.id).toBe('37ddff8e-e13f-4e57-937f-d048fa323f5e:12')
	})

	it('keys on the event’s OWN session, not the stream it arrives on', () => {
		// A parent's stream carries its children's events, each numbered in the
		// child's log. Stamping the enclosing session here produces a cursor
		// that addresses the wrong sequence — and it looks right.
		const child = '4721e070-5ba2-425a-bf5a-8cc927907e9a' as SessionId

		const mapped = mapSessionEventToStreamEvent({
			type: 'iteration_started',
			sessionId: child,
			turnId: TID,
			iteration: 1,
			seq: 3,
		} as SessionEvent)

		expect(mapped?.id).toBe('4721e070-5ba2-425a-bf5a-8cc927907e9a:3')
	})

	it('leaves the id off an event that is not recoverable', () => {
		// A delta is never persisted, so an id on it would be a cursor pointing
		// at a sequence the log has never heard of. A client that advanced onto
		// it and reconnected would be told it is ahead of the log.
		const mapped = mapSessionEventToStreamEvent({
			type: 'text_delta',
			sessionId: SID,
			turnId: TID,
			iteration: 1,
			messageId: 'm1',
			text: 'x',
		} as unknown as SessionEvent)

		expect(mapped?.wire).toBe('message.delta')
		expect(mapped?.id).toBeUndefined()
	})

	it('leaves the id off an event whose durable write failed', () => {
		// Same envelope shape as an ephemeral one, and the same meaning: no seq,
		// no cursor.
		const mapped = mapSessionEventToStreamEvent({
			type: 'turn_paused',
			sessionId: SID,
			turnId: TID,
			checkpointId: fixtureId.checkpoint('1'),
			reason: 'review',
		} as SessionEvent)

		expect(mapped?.wire).toBe('turn.paused')
		expect(mapped?.id).toBeUndefined()
	})
})
