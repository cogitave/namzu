import { describe, expect, it } from 'vitest'

import type { RunExecutionStatus } from '../index.js'
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
 * The rename shipped with the old name as an alias, which is the
 * deprecate-before-remove rule; 28.0.0 carried that warning to the registry
 * and NZ-RUNREC-14 removed the alias. What is left to pin is the union
 * itself — the thing the rename was about.
 */

describe('the run lifecycle union', () => {
	it('treats exactly the three settled values as terminal', () => {
		// Pinned member by member rather than by count: adding a seventh
		// member to the union and forgetting it here would otherwise pass.
		const settled: RunExecutionStatus[] = ['completed', 'failed', 'cancelled']
		const live: RunExecutionStatus[] = ['idle', 'pending', 'running']

		expect(settled.map(isTerminalStatus)).toEqual([true, true, true])
		expect(live.map(isTerminalStatus)).toEqual([false, false, false])
	})
})
