import { describe, expect, it } from 'vitest'

import { fixtureId, unchecked } from '../../../test-support/ids.js'
import {
	InvalidIdError,
	asGoalId,
	asSessionId,
	asTenantId,
	asTurnId,
	generateGoalId,
	generateTurnId,
	isEntityId,
} from '../../../utils/id.js'
import type { GoalId, SessionId, TenantId, TurnId } from '../index.js'

/**
 * The id types are nominal, and this file is what keeps them that way.
 *
 * Half of it is not a runtime test at all. Each `@ts-expect-error` below is a
 * NEGATIVE typecheck: it asserts that the line under it does not compile, and
 * TypeScript reports `@ts-expect-error` itself as an error when the expected
 * error is absent. So deleting the brand from `../index.ts` — or widening one
 * id back to a bare string — turns every one of these into a build
 * failure in `pnpm typecheck`, which is the CI step this has to be caught by.
 * A test that only ran at runtime could not see any of it: the whole property
 * is erased before a single line executes.
 *
 * The other half is the honest boundary. A brand does NOT stop a type
 * assertion, and the section at the bottom pins that too — so nobody reads
 * "the ids are nominal" as "a fake id is now impossible" and stops looking.
 */

describe('an id is not a string', () => {
	it('refuses a bare literal in an id position', () => {
		// @ts-expect-error a `turn_`-shaped literal is not a TurnId: ids are minted
		const fake: TurnId = 'turn_not_minted'
		// The value still EXISTS at runtime — the brand is a compile-time
		// property and erases to nothing. Asserting that is the point: it is why
		// the `@ts-expect-error` above is the real check and this line is not.
		expect(fake).toBe('turn_not_minted')
	})

	it('refuses a template literal in an id position', () => {
		const suffix = 'abc'
		// @ts-expect-error interpolating the right prefix does not mint an id
		const fake: SessionId = `ses_${suffix}`
		expect(fake).toBe('ses_abc')
	})

	it('refuses one id type where another was asked for', () => {
		const turn = generateTurnId()
		// @ts-expect-error a TurnId is not a SessionId, prefixes aside
		const wrong: SessionId = turn
		expect(wrong).toBe(turn)
	})

	it('does not encode a wire prefix into the nominal type', () => {
		const turn = generateTurnId()
		// @ts-expect-error callers cannot derive a serialized prefix from an opaque id
		const prefixed: `turn_${string}` = turn
		expect(prefixed).toBe(turn)
	})

	it('narrows an untyped boundary using the caller-supplied entity kind', () => {
		const value: unknown = generateTurnId()
		if (!isEntityId(value, 'turn')) throw new Error('Expected the minted turn id to validate')
		const turn: TurnId = value
		// @ts-expect-error a turn check cannot establish a session identity
		const session: SessionId = value
		expect(turn).toBe(value)
		expect(session).toBe(value)
	})

	it('refuses a plain string in an id position', () => {
		const raw: string = 'turn_from_a_url'
		// @ts-expect-error a string that happens to look right is still a string
		const fake: TurnId = raw
		expect(fake).toBe(raw)
	})

	it('accepts what the three legitimate producers return', () => {
		// Minted, checked, and the fixture constructor — the only three ways an
		// id can come into existence, and each satisfies the type with no
		// assertion at the call site.
		const minted: TurnId = generateTurnId()
		const checked: TurnId = asTurnId('6e86e19a-b453-41c0-8b43-131c6a442e7d')
		const goal: GoalId = generateGoalId()
		const checkedGoal: GoalId = asGoalId('8960161a-9da0-4128-8871-f5042ce1ca9b')
		const fixture: TurnId = fixtureId.turn('from_a_test')
		const sentinel: TenantId = asTenantId('1fe7a516-1f59-4c7b-8767-d4a46eeaac32')

		expect(asTurnId(minted)).toBe(minted)
		expect(checked).toBe('6e86e19a-b453-41c0-8b43-131c6a442e7d')
		expect(asGoalId(goal)).toBe(goal)
		expect(checkedGoal).toBe('8960161a-9da0-4128-8871-f5042ce1ca9b')
		expect(fixture).toBe('42797211-7875-4f09-850b-5a4ee62a52ab')
		expect(sentinel).toBe('1fe7a516-1f59-4c7b-8767-d4a46eeaac32')
	})

	it('rejects non-UUID values at runtime, which the brand cannot', () => {
		// The brand says "this came from a producer"; it says nothing about
		// WHICH prefix, because a `ses_` string asserted into a TurnId carries
		// the same brand a real one does. The runtime check is the half that
		// catches a value read from a log, a URL or a flag.
		expect(() => asTurnId('ses_wrong_kind')).toThrow(InvalidIdError)
		expect(() => asSessionId('turn_wrong_kind')).toThrow(InvalidIdError)
		expect(() => asGoalId('ses_wrong_kind')).toThrow(InvalidIdError)
		expect(() => asTurnId('')).toThrow(InvalidIdError)
	})
})

describe('what the brand does NOT stop', () => {
	/**
	 * Stated as tests rather than as a comment, because the gap is the sort a
	 * reader assumes closed. Both of these COMPILE. If a future change makes
	 * them stop compiling — a lint rule banning `as <IdType>`, say — these
	 * assertions are where that shows up, and the file's own header is what
	 * has to be corrected.
	 */

	it('an assertion from a literal still mints a fake', () => {
		const fake = 'turn_totally_made_up' as TurnId
		expect(fake).toBe('turn_totally_made_up')
	})

	it('an assertion from an arbitrary string still compiles', () => {
		const fromTheWire: string = 'not even close'
		const fake = fromTheWire as TurnId
		expect(fake).toBe('not even close')
	})

	it('and so does the fixture escape hatch, which is why it is named that way', () => {
		const fake = unchecked<TurnId>('nonsense')
		expect(fake).toBe('nonsense')
	})
})
