import { describe, expect, it } from 'vitest'

import {
	RUN_EVENT_FIXTURES as FIXTURES,
	FIXTURE_RUN_ID as RID,
} from '../../__fixtures__/run-event-fixtures.js'
import { mapRunToStreamEvent } from '../mapper.js'

/**
 * The SSE wire, pinned by shape rather than by memory.
 *
 * Coverage here was a 27-line hand-maintained doc comment listing the
 * expected wire names, plus hand-written assertions for the events
 * somebody thought to write one for. A mapper could rename `run_id` to
 * `runId`, or drop a field from a payload, and nothing would notice unless
 * that event happened to be one of the few with an assertion.
 *
 * The exhaustiveness that makes this hold lives in the fixture module.
 */

describe('every RunEvent has a decided place on the SSE wire', () => {
	it('maps or declines each one, and never throws', () => {
		// The exhaustiveness half. A member added to the union without a
		// mapper entry fails `tsc` at the mapper's own table; a member added
		// WITH one but never exercised reaches the wire untested, which is
		// what this closes.
		for (const [type, build] of Object.entries(FIXTURES)) {
			expect(() => mapRunToStreamEvent(build(), RID), type).not.toThrow()
		}
	})

	it('pins the wire name and payload keys of everything it maps', () => {
		// Keys, not values: values are fixture artefacts, and asserting them
		// would make this snapshot a record of what the fixtures happen to
		// say. Keys are the contract a consumer parses.
		const shape: Record<string, { wire: string; keys: string[] } | null> = {}
		for (const [type, build] of Object.entries(FIXTURES)) {
			const mapped = mapRunToStreamEvent(build(), RID)
			shape[type] = mapped
				? { wire: mapped.wire, keys: Object.keys(mapped.data as object).sort() }
				: null
		}

		expect(shape).toMatchSnapshot()
	})

	it('declines nothing by accident: every null is a decision with a name', () => {
		// A `null` from the mapper means "this runtime's business, not the
		// wire's". Listed explicitly so ADDING one shows up in review — an
		// event silently dropped from the wire looks exactly like an event
		// nobody has needed yet.
		const declined = Object.entries(FIXTURES)
			.filter(([, build]) => mapRunToStreamEvent(build(), RID) === null)
			.map(([type]) => type)
			.sort()

		expect(declined).toMatchSnapshot()
	})
})
