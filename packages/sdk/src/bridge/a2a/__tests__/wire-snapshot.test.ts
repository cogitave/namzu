import { describe, expect, it } from 'vitest'

import { RUN_EVENT_FIXTURES as FIXTURES } from '../../__fixtures__/run-event-fixtures.js'
import { mapRunToA2AEvent } from '../mapper.js'

/**
 * The A2A wire, pinned the same way as the SSE one and against the same
 * fixtures.
 *
 * This mapper declines far more than it maps, and that asymmetry is the
 * reason it needs pinning at least as much: a peer models a task
 * lifecycle, so most of what this runtime says about its own internals is
 * correctly `null` here. Which makes an accidental `null` — an event that
 * used to reach a peer and quietly stopped — indistinguishable from the
 * forty that never should.
 *
 * Sharing one fixture map with the SSE test is the point rather than a
 * convenience: two lists would drift, each file would keep compiling and
 * passing, and the two wires would be tested against different events.
 */

describe('every RunEvent has a decided place on the A2A wire', () => {
	it('maps or declines each one, and never throws', () => {
		for (const [type, build] of Object.entries(FIXTURES)) {
			expect(() => mapRunToA2AEvent(build(), 'ctx_wire'), type).not.toThrow()
		}
	})

	it('pins the shape of everything it maps', () => {
		// Keys, not values — values are fixture artefacts. The A2A payload is
		// nested, so the top-level keys plus the status kind is what a peer
		// actually branches on.
		const shape: Record<string, unknown> = {}
		for (const [type, build] of Object.entries(FIXTURES)) {
			const mapped = mapRunToA2AEvent(build(), 'ctx_wire')
			shape[type] = mapped ? Object.keys(mapped as object).sort() : null
		}

		expect(shape).toMatchSnapshot()
	})

	it('lists what it declines, so a new decline is visible in review', () => {
		// The set is large by design. That is exactly why it has to be
		// written down: one more entry looks like nothing at all.
		const declined = Object.entries(FIXTURES)
			.filter(([, build]) => mapRunToA2AEvent(build(), 'ctx_wire') === null)
			.map(([type]) => type)
			.sort()

		expect(declined).toMatchSnapshot()
	})

	it('declines more than it maps, and both sets are non-empty', () => {
		// Guards the two snapshots from the failure a snapshot cannot catch:
		// a mapper that returned `null` for everything would pin a perfectly
		// stable, perfectly useless picture.
		const outcomes = Object.values(FIXTURES).map((build) =>
			mapRunToA2AEvent(build(), 'ctx_wire') === null ? 'declined' : 'mapped',
		)
		const declined = outcomes.filter((o) => o === 'declined').length
		const mapped = outcomes.length - declined

		expect(mapped).toBeGreaterThan(0)
		expect(declined).toBeGreaterThan(mapped)
	})
})
