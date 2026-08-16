import { describe, expect, it } from 'vitest'

import type { TaskScheduler } from '../../../types/agent/scheduler.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * Whether a run may delegate is not the same question as who it may delegate
 * to, and only the caller can answer the first.
 *
 * The roster answers WHO. It cannot answer WHETHER, because two runs are
 * indistinguishable in it: a supervisor whose roster happens to hold one
 * specialist, where delegating is the point; and a run whose own persona IS
 * that specialist, where delegating is delegating to itself. A host builds the
 * second by putting a specialist's persona into the supervisor shell and its
 * id into the roster — so a predicate comparing the roster against the
 * executing agent sees two different ids and cheerfully says "can delegate".
 *
 * Measured before this existed: such a run carried `create_task`,
 * `wait_for_task`, `cancel_task` and `agent_task_list`, byte-identical to a
 * run that could actually delegate, and the model could only discover the
 * refusal by spending a turn on it.
 */

const gateway = {
	listTasks: () => [],
	onTaskCompleted: () => () => {},
} as unknown as TaskScheduler

function namesFor(opts: {
	agentIds: string[]
	allowDelegation?: boolean
	withHitl?: boolean
}): string[] {
	return buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds: opts.agentIds,
		...(opts.allowDelegation !== undefined ? { allowDelegation: opts.allowDelegation } : {}),
		...(opts.withHitl
			? { resumeHandler: (async () => ({ action: 'continue' })) as never, runId: 'run_1' as never }
			: {}),
	}).map((t) => t.name)
}

describe('a run can decline to delegate while still naming who it would have called', () => {
	it('withholds the delegation tools when delegation is off', () => {
		const names = namesFor({ agentIds: ['specialist'], allowDelegation: false })

		expect(names).not.toContain('create_task')
		expect(names).not.toContain('wait_for_task')
		expect(names).not.toContain('cancel_task')
	})

	it('produces exactly the empty-roster surface', () => {
		// The two reasons differ but the outcome is the same one tool, so a
		// reader does not have to hold two shapes in their head.
		expect(namesFor({ agentIds: ['specialist'], allowDelegation: false })).toEqual(
			namesFor({ agentIds: [] }),
		)
	})

	it('keeps the listing, because a run may still want to see what is running', () => {
		expect(namesFor({ agentIds: ['specialist'], allowDelegation: false })).toContain(
			'agent_task_list',
		)
	})

	it('leaves the human channel alone — that is not delegation', () => {
		// `approve_plan` and `ask_user_question` are the HITL park surface. A
		// run that must not delegate needs them as much as any other.
		const names = namesFor({ agentIds: ['specialist'], allowDelegation: false, withHitl: true })

		expect(names).toContain('ask_user_question')
	})
})

describe('an absent flag changes nothing', () => {
	it('mounts the full surface, as it always did', () => {
		const names = namesFor({ agentIds: ['specialist'] })

		expect(names).toContain('create_task')
		expect(names).toContain('wait_for_task')
		expect(names).toContain('cancel_task')
		expect(names).toContain('agent_task_list')
	})

	it('is identical to opting in explicitly', () => {
		// So adopting the flag cannot change a caller that says yes out loud.
		expect(namesFor({ agentIds: ['a', 'b'], allowDelegation: true })).toEqual(
			namesFor({ agentIds: ['a', 'b'] }),
		)
	})

	it('still withholds everything on an empty roster, flag or no flag', () => {
		expect(namesFor({ agentIds: [], allowDelegation: true })).toEqual(['agent_task_list'])
	})
})

describe('the flag is absolute', () => {
	it('cannot be overridden back on', () => {
		// Worth a test precisely because the opposite is the intuitive guess:
		// "explicit beats implicit" would say a runtime override should win.
		// It cannot, mechanically — the override pass in SupervisorAgent runs
		// over the array this builder returns, and there is no entry for it to
		// act on. And it should not: both values come from the same caller in
		// the same call, so "this run must not delegate" plus "give it
		// create_task" is a caller contradicting itself, not one who knows
		// something extra.
		//
		// Same rule the empty roster has always had.
		const tools = buildCoordinatorTools({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['specialist'],
			allowDelegation: false,
		})

		expect(tools.find((t) => t.name === 'create_task')).toBeUndefined()
	})
})
