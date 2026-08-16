import { describe, expect, expectTypeOf, it } from 'vitest'

import type { SessionStatus } from '../entity.js'
import type { SubSessionDelegationStatus, SubSessionStatus } from '../sub-session.js'

/**
 * Two unions, three shared member names, and nothing saying which record
 * answers "is this active".
 *
 * A `SubSession` is the EDGE from a parent to a child. The child itself is
 * an ordinary `Session` with its own `SessionStatus`. Both carry `active`,
 * `idle` and `archived`; `SessionStatus` additionally carries
 * `awaiting_merge`, which the sub-session union also declared. So the same
 * word meant two different things one import apart.
 *
 * Six of the eleven sub-session members had no writer at all. Two of those
 * six had a READER — they sat in the archival set, matching values that
 * could not occur.
 */

describe('the delegation union says what the kernel writes', () => {
	it('is exactly the five values a code path produces', () => {
		// Enforced by `tsc`, not by this run: `expectTypeOf` erases. Adding a
		// member to `SubSessionDelegationStatus` fails the Type check step,
		// which is where this assertion lives.
		expectTypeOf<SubSessionDelegationStatus>().toEqualTypeOf<
			'pending' | 'active' | 'idle' | 'failed' | 'archived'
		>()
	})

	it('is a strict subset of the wide alias, so a held value still typechecks', () => {
		// The deprecation's whole promise: a host that persisted one of the
		// six merge values keeps compiling for a release. Narrowing the alias
		// instead of widening from it fails here.
		expectTypeOf<SubSessionDelegationStatus>().toMatchTypeOf<SubSessionStatus>()
	})

	it('shares three member names with the child session union, which is the confusion', () => {
		// Runtime, and deliberately so — this is the fact the rename exists
		// to make legible, and it should be readable without a type checker.
		const delegation: readonly string[] = ['pending', 'active', 'idle', 'failed', 'archived']
		const session: readonly SessionStatus[] = [
			'active',
			'idle',
			'locked',
			'awaiting_hitl',
			'awaiting_merge',
			'failed',
			'archived',
		]

		const shared = session.filter((s) => delegation.includes(s))

		expect(shared).toEqual(['active', 'idle', 'failed', 'archived'])
		// `awaiting_merge` belongs to the child's own work, never to the edge.
		expect(delegation).not.toContain('awaiting_merge')
	})
})
