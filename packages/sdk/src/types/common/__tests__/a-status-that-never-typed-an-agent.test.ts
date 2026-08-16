import { describe, expect, expectTypeOf, it } from 'vitest'

import type { AgentStatus, RunExecutionStatus } from '../index.js'
import { isTerminalStatus } from '../index.js'

/**
 * `AgentStatus` never typed an agent.
 *
 * Every one of its uses in this package was a run's status, a run's audit
 * outcome, or the status field of a run's result. `AbstractAgent` and
 * `ReactiveAgent` have no status of their own — an agent is a
 * configuration, and it is the RUN that is idle, running or cancelled. So
 * a reader importing `AgentStatus` to describe an agent's lifecycle was
 * reaching for a type that governs something else, and the name was the
 * only thing telling them otherwise.
 *
 * The rename ships with the old name as an alias rather than replacing
 * it, which is the deprecate-before-remove rule: code written against
 * `AgentStatus` still compiles and warns for one release.
 */

describe('the run lifecycle union', () => {
	it('keeps the old name assignable in both directions, so it is an alias and not a copy', () => {
		// ENFORCED BY `tsc`, NOT BY THIS RUN. `expectTypeOf` erases at
		// runtime, so `vitest` reports this green whatever the types say —
		// verified by making `AgentStatus` a five-member copy, which vitest
		// still passed and `tsc --noEmit` rejected at both lines below. CI's
		// Type check step is the gate; running the suite alone does not
		// establish this one.
		//
		// Both directions on purpose. A second declaration listing the same
		// six members satisfies a one-directional check and then drifts the
		// first time either union gains a member.
		expectTypeOf<AgentStatus>().toEqualTypeOf<RunExecutionStatus>()
		expectTypeOf<RunExecutionStatus>().toEqualTypeOf<AgentStatus>()
	})

	it('accepts a value typed with the deprecated name at the new signature', () => {
		// `isTerminalStatus` was retyped to `RunExecutionStatus`. A consumer
		// still holding an `AgentStatus` must be able to call it — that is the
		// whole point of keeping the alias rather than deleting it.
		const legacy: AgentStatus = 'completed'

		expect(isTerminalStatus(legacy)).toBe(true)
	})

	it('treats exactly the three settled values as terminal', () => {
		// Pinned member by member rather than by count: adding a seventh
		// member to the union and forgetting it here would otherwise pass.
		const settled: RunExecutionStatus[] = ['completed', 'failed', 'cancelled']
		const live: RunExecutionStatus[] = ['idle', 'pending', 'running']

		expect(settled.map(isTerminalStatus)).toEqual([true, true, true])
		expect(live.map(isTerminalStatus)).toEqual([false, false, false])
	})
})
