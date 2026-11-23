import { describe, expect, it } from 'vitest'

import {
	DELEGATION_TOOLS_WHEN_BUSY,
	EAGER_TOOLS_WHEN_DEFERRED,
	delegationIsBusy,
	eagerToolsFor,
} from './agent.js'

describe('the tools a deferring session sends with every request', () => {
	it('include web_fetch, so reading a page needs no search first', () => {
		expect(eagerToolsFor({})).toContain('web_fetch')
		expect(EAGER_TOOLS_WHEN_DEFERRED).toContain('web_fetch')
	})

	it('leave the agent and workflow tools to the busy list', () => {
		for (const name of DELEGATION_TOOLS_WHEN_BUSY) {
			expect((EAGER_TOOLS_WHEN_DEFERRED as readonly string[]).includes(name)).toBe(false)
		}
		expect(DELEGATION_TOOLS_WHEN_BUSY).toContain('wait_for_task')
		expect(DELEGATION_TOOLS_WHEN_BUSY).toContain('agent_task_list')
	})
})

describe('a turn that works with delegated work', () => {
	const idle = { hypermode: false, liveAgents: 0, runningWorkflows: 0 }
	it('is not busy when nothing is on and nothing runs', () => {
		expect(delegationIsBusy(idle)).toBe(false)
	})
	it('is busy under hypermode, with a live agent, or with a running workflow', () => {
		expect(delegationIsBusy({ ...idle, hypermode: true })).toBe(true)
		expect(delegationIsBusy({ ...idle, liveAgents: 1 })).toBe(true)
		expect(delegationIsBusy({ ...idle, runningWorkflows: 1 })).toBe(true)
	})
})
