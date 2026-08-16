import { describe, expect, it } from 'vitest'

import type { ApprovalPolicy, RunApprovalPolicy } from '../../../types/hitl/policy.js'
import type { RunId } from '../../../types/ids/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { AUTO_APPROVE_POLICY_NAME, createRunApprovalPolicy } from '../approval-policy.js'

/**
 * Who answers when the run asks a human, as a value rather than a closure.
 *
 * `ResumeHandler` was captured at `query()` start and never read again from
 * anywhere reachable, so switching from "ask me about every write" to "go
 * ahead, I'm stepping out" meant ending the run — discarding the in-flight
 * step and the context it was built from, to change one setting.
 *
 * The durable record is half the feature and not an afterthought. An
 * incident review that can see approvals but not which rule granted them is
 * the state this event exists to prevent.
 */

const RUN = 'run_policy' as RunId

const policy = (name: string): ApprovalPolicy => ({
	name,
	handler: async () => ({ action: 'continue' }),
})

function box(initial: ApprovalPolicy): { policy: RunApprovalPolicy; events: RunEvent[] } {
	const events: RunEvent[] = []
	const runApprovalPolicy = createRunApprovalPolicy({
		runId: RUN,
		initial,
		emit: async (event) => {
			events.push(event)
		},
	})
	return { policy: runApprovalPolicy, events }
}

describe('the policy is read through the box, not captured', () => {
	it('hands back the CURRENT policy after a change', async () => {
		// A caller holding this object across a change must see the change; a
		// captured field would return the policy that was current when it
		// looked, which is the defect the box exists to remove.
		const { policy: runPolicy } = box(policy('operator-tui'))
		const held = runPolicy

		await runPolicy.set(policy(AUTO_APPROVE_POLICY_NAME), 'operator stepped away')

		expect(held.current.name).toBe(AUTO_APPROVE_POLICY_NAME)
	})

	it('routes a question to the new handler', async () => {
		const asked: string[] = []
		const first: ApprovalPolicy = {
			name: 'first',
			handler: async () => {
				asked.push('first')
				return { action: 'continue' }
			},
		}
		const second: ApprovalPolicy = {
			name: 'second',
			handler: async () => {
				asked.push('second')
				return { action: 'continue' }
			},
		}
		const { policy: runPolicy } = box(first)

		await runPolicy.current.handler({} as never)
		await runPolicy.set(second, 'switched')
		await runPolicy.current.handler({} as never)

		expect(asked).toEqual(['first', 'second'])
	})
})

describe('a change is recorded, and recorded first', () => {
	it('emits from, to and why', async () => {
		const { policy: runPolicy, events } = box(policy('operator-tui'))

		await runPolicy.set(policy('auto-approve'), 'operator stepped away')

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({
			type: 'approval_policy_changed',
			runId: RUN,
			from: 'operator-tui',
			to: 'auto-approve',
			reason: 'operator stepped away',
		})
	})

	it('records BEFORE the swap takes effect', async () => {
		// Swap first and the log reads as approvals that precede the decision
		// permitting them — exactly backwards for the one question this event
		// is kept to answer.
		let nameWhenRecorded: string | undefined
		const runPolicy = createRunApprovalPolicy({
			runId: RUN,
			initial: policy('operator-tui'),
			emit: async () => {
				nameWhenRecorded = runPolicy.current.name
			},
		})

		await runPolicy.set(policy('auto-approve'), 'stepping out')

		expect(nameWhenRecorded).toBe('operator-tui')
		expect(runPolicy.current.name).toBe('auto-approve')
	})

	it('carries names, never the handler', async () => {
		// A durable log cannot hold a function, and `[Function (anonymous)]`
		// is what a log says when somebody tries.
		const { policy: runPolicy, events } = box(policy('operator-tui'))

		await runPolicy.set(policy('auto-approve'), 'x')

		expect(JSON.stringify(events)).not.toContain('function')
		expect(JSON.parse(JSON.stringify(events[0]))).toMatchObject({ to: 'auto-approve' })
	})

	it('says nothing when nothing changed', async () => {
		// An entry saying the policy changed from `operator-tui` to
		// `operator-tui` teaches a reader that these are noise, and the one
		// that matters is then one of many.
		const same = policy('operator-tui')
		const { policy: runPolicy, events } = box(same)

		await runPolicy.set(same, 'no-op')

		expect(events).toHaveLength(0)
	})

	it('DOES record a same-named policy with a different handler', async () => {
		// Same name, different behaviour is a real change and the more
		// dangerous of the two — it is the one a reader cannot spot from the
		// names alone.
		const { policy: runPolicy, events } = box(policy('operator-tui'))

		await runPolicy.set(policy('operator-tui'), 'reconnected to a new session')

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ from: 'operator-tui', to: 'operator-tui' })
	})

	it('records every change, not only the first', async () => {
		const { policy: runPolicy, events } = box(policy('a'))

		await runPolicy.set(policy('b'), 'one')
		await runPolicy.set(policy('c'), 'two')

		expect(events.map((e) => (e as { to: string }).to)).toEqual(['b', 'c'])
		expect(events.map((e) => (e as { from: string }).from)).toEqual(['a', 'b'])
	})
})

describe('the model is told once, and only about the state it is now under', () => {
	it('reports the change, then reports nothing', async () => {
		// Told twice is worse than a plain notice: the second copy reads as a
		// second change, and the model will believe supervision moved again.
		const { policy: runPolicy } = box(policy('operator-tui'))
		await runPolicy.set(policy('auto-approve'), 'operator stepped away')

		const first = runPolicy.takeUnannouncedChange()
		const second = runPolicy.takeUnannouncedChange()

		expect(first).toMatchObject({
			from: 'operator-tui',
			to: 'auto-approve',
			reason: 'operator stepped away',
		})
		expect(second).toBeUndefined()
	})

	it('has nothing to report before anything changed', async () => {
		const { policy: runPolicy } = box(policy('operator-tui'))

		expect(runPolicy.takeUnannouncedChange()).toBeUndefined()
	})

	it('collapses A→B→C into A→C', async () => {
		// Three swaps between two model calls are ONE fact by the time the
		// model can act on one. Replaying the intermediate ones describes a
		// history where the model needs a state — and `from` staying at the
		// original is what makes the statement true about what it planned
		// under versus what it is under now.
		const { policy: runPolicy } = box(policy('a'))
		await runPolicy.set(policy('b'), 'one')
		await runPolicy.set(policy('c'), 'two')

		expect(runPolicy.takeUnannouncedChange()).toMatchObject({ from: 'a', to: 'c', reason: 'two' })
	})

	it('starts reporting again after a later change', async () => {
		// Cleared, not disabled. A run whose policy moves twice with a model
		// call between them owes the model two notices.
		const { policy: runPolicy } = box(policy('a'))
		await runPolicy.set(policy('b'), 'one')
		runPolicy.takeUnannouncedChange()

		await runPolicy.set(policy('c'), 'two')

		expect(runPolicy.takeUnannouncedChange()).toMatchObject({ from: 'b', to: 'c' })
	})

	it('reports nothing for a no-op set', async () => {
		const same = policy('a')
		const { policy: runPolicy } = box(same)

		await runPolicy.set(same, 'nothing really')

		expect(runPolicy.takeUnannouncedChange()).toBeUndefined()
	})
})
