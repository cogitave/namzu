import { describe, expect, it } from 'vitest'

import { fixtureId, unchecked } from '../../../test-support/ids.js'
import {
	InvalidIdError,
	asGoalId,
	asRunId,
	asSessionId,
	generateGoalId,
	generateRunId,
} from '../../../utils/id.js'
import { UNKNOWN_TENANT_ID } from '../index.js'
import type { GoalId, RunId, SessionId, TenantId } from '../index.js'

/**
 * The id types are nominal, and this file is what keeps them that way.
 *
 * Half of it is not a runtime test at all. Each `@ts-expect-error` below is a
 * NEGATIVE typecheck: it asserts that the line under it does not compile, and
 * TypeScript reports `@ts-expect-error` itself as an error when the expected
 * error is absent. So deleting the brand from `../index.ts` — or widening one
 * id back to a bare template literal — turns every one of these into a build
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
		// @ts-expect-error a `run_`-shaped literal is not a RunId: ids are minted
		const fake: RunId = 'run_not_minted'
		// The value still EXISTS at runtime — the brand is a compile-time
		// property and erases to nothing. Asserting that is the point: it is why
		// the `@ts-expect-error` above is the real check and this line is not.
		expect(fake).toBe('run_not_minted')
	})

	it('refuses a template literal in an id position', () => {
		const suffix = 'abc'
		// @ts-expect-error interpolating the right prefix does not mint an id
		const fake: SessionId = `ses_${suffix}`
		expect(fake).toBe('ses_abc')
	})

	it('refuses one id type where another was asked for', () => {
		const run = generateRunId()
		// @ts-expect-error a RunId is not a SessionId, prefixes aside
		const wrong: SessionId = run
		expect(wrong).toBe(run)
	})

	it('refuses a plain string in an id position', () => {
		const raw: string = 'run_from_a_url'
		// @ts-expect-error a string that happens to look right is still a string
		const fake: RunId = raw
		expect(fake).toBe(raw)
	})

	it('accepts what the three legitimate producers return', () => {
		// Minted, checked, and the fixture constructor — the only three ways an
		// id can come into existence, and each satisfies the type with no
		// assertion at the call site.
		const minted: RunId = generateRunId()
		const checked: RunId = asRunId('run_from_a_log_line')
		const goal: GoalId = generateGoalId()
		const checkedGoal: GoalId = asGoalId('goal_from_a_session')
		const fixture: RunId = fixtureId.run('from_a_test')
		const sentinel: TenantId = UNKNOWN_TENANT_ID

		expect(minted.startsWith('run_')).toBe(true)
		expect(checked).toBe('run_from_a_log_line')
		expect(goal.startsWith('goal_')).toBe(true)
		expect(checkedGoal).toBe('goal_from_a_session')
		expect(fixture).toBe('run_from_a_test')
		expect(sentinel).toBe('tnt_unknown_legacy')
	})

	it('still checks the prefix at runtime, which the brand cannot', () => {
		// The brand says "this came from a producer"; it says nothing about
		// WHICH prefix, because a `ses_` string asserted into a RunId carries
		// the same brand a real one does. The runtime check is the half that
		// catches a value read from a log, a URL or a flag.
		expect(() => asRunId('ses_wrong_kind')).toThrow(InvalidIdError)
		expect(() => asSessionId('run_wrong_kind')).toThrow(InvalidIdError)
		expect(() => asGoalId('ses_wrong_kind')).toThrow(InvalidIdError)
		expect(() => asRunId('')).toThrow(InvalidIdError)
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
		const fake = 'run_totally_made_up' as RunId
		expect(fake).toBe('run_totally_made_up')
	})

	it('an assertion from an arbitrary string still compiles', () => {
		const fromTheWire: string = 'not even close'
		const fake = fromTheWire as RunId
		expect(fake).toBe('not even close')
	})

	it('and so does the fixture escape hatch, which is why it is named that way', () => {
		const fake = unchecked<RunId>('nonsense')
		expect(fake).toBe('nonsense')
	})
})
