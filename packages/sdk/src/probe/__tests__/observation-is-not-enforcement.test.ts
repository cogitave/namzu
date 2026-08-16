import { describe, expect, expectTypeOf, it } from 'vitest'

import type { ProbeEnforcement, ProbeObservation } from '../registry.js'
import { ProbeRegistry } from '../registry.js'

/**
 * The SDK barrel introduced this module as "typed observation over
 * AgentBus + RunEvent stream". That is what `on`, `onAny` and `dispatch`
 * do. It is not what `veto` and `queryVeto` do: a registered veto handler
 * denies a tool call and the executor turns that denial into a failed
 * `tool_result`, which is enforcement — the third of the three gates on a
 * tool call, sitting behind a name that said telemetry.
 *
 * There was also no way to ask for less. `ProbeRegistry` was the only
 * export, so a consumer that wanted to watch had to accept the power to
 * refuse, and a signature could not say which it needed.
 */

describe('the two halves of a probe registry', () => {
	it('gives observation no way to refuse', () => {
		// Enforced by `tsc`, not by this run. Adding `veto` to
		// `ProbeObservation` — or typing a consumer as the whole registry
		// again — fails the Type check step, not this assertion.
		expectTypeOf<ProbeObservation>().not.toHaveProperty('veto')
		expectTypeOf<ProbeObservation>().not.toHaveProperty('queryVeto')
	})

	it('gives enforcement no way to observe', () => {
		expectTypeOf<ProbeEnforcement>().not.toHaveProperty('on')
		expectTypeOf<ProbeEnforcement>().not.toHaveProperty('dispatch')
	})

	it('is satisfied by one registry, so the split costs a consumer nothing', () => {
		// The split is a narrowing of signatures, not a second object to
		// build. A host still constructs one registry and passes it wherever
		// either half is asked for.
		const registry = new ProbeRegistry()

		const observing: ProbeObservation = registry
		const enforcing: ProbeEnforcement = registry

		expect(observing).toBe(enforcing)
		expect(typeof observing.dispatch).toBe('function')
		expect(typeof enforcing.queryVeto).toBe('function')
	})

	it('still enforces: a veto handler denies, and the verdict says so', () => {
		// The behaviour the old name denied. If this passes while
		// `ProbeEnforcement` is described as observation, the description is
		// the thing that is wrong.
		const registry = new ProbeRegistry()
		registry.veto('tool_executing', () => ({ action: 'deny', reason: 'not on my watch' }), {
			name: 'test-veto',
		})

		const outcome = registry.queryVeto(
			{ type: 'tool_executing', toolName: 'shell' } as never,
			{} as never,
		)

		expect(outcome.action).toBe('deny')
		expect(outcome.reason).toBe('not on my watch')
		expect(outcome.probeName).toBe('test-veto')
	})
})
