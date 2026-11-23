import { ToolManager, toolset } from '@namzu/sdk'
import type { ToolDefinition } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	DELEGATION_TOOLS_WHEN_BUSY,
	EAGER_TOOLS_WHEN_DEFERRED,
	deferExceptToolset,
	delegationIsBusy,
	eagerToolsFor,
	eagerToolsWithDelegation,
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

function fakeTool(name: string): ToolDefinition {
	return {
		name,
		description: `Do ${name}.`,
		inputSchema: { parse: (value: unknown) => value } as unknown as ToolDefinition['inputSchema'],
		execute: async () => ({ success: true, output: 'ok' }),
	}
}

describe('the tool list a deferring session builds', () => {
	const names = ['web_fetch', 'wait_for_task', 'agent_task_list', 'obscure_tool']
	const base = toolset('test', names.map(fakeTool))
	const manager = (eager: readonly string[]) =>
		new ToolManager({ toolsets: deferExceptToolset(base, eager), messages: () => [] })

	it('holds web_fetch loaded and the delegation tools behind a search', () => {
		const m = manager(eagerToolsFor({}))
		expect(m.availability('web_fetch')).toBe('active')
		expect(m.availability('wait_for_task')).toBe('deferred')
		expect(m.availability('obscure_tool')).toBe('deferred')
	})

	it('loads the delegation tools when the turn is busy', () => {
		const m = manager([...eagerToolsFor({}), ...DELEGATION_TOOLS_WHEN_BUSY])
		expect(m.availability('web_fetch')).toBe('active')
		expect(m.availability('wait_for_task')).toBe('active')
		expect(m.availability('agent_task_list')).toBe('active')
		expect(m.availability('obscure_tool')).toBe('deferred')
	})
})

describe('a session that can launch an agent or a workflow', () => {
	it('holds the task tools loaded from boot, so a mid-turn launch needs no search', () => {
		const base = toolset(
			'test',
			['web_fetch', 'agent', 'wait_for_task', 'agent_task_list', 'send_message', 'stop_task'].map(
				fakeTool,
			),
		)
		const eager = eagerToolsWithDelegation(eagerToolsFor({}), true)
		const m = new ToolManager({ toolsets: deferExceptToolset(base, eager), messages: () => [] })
		for (const name of DELEGATION_TOOLS_WHEN_BUSY) expect(m.availability(name)).toBe('active')
		expect(m.availability('agent')).toBe('deferred')
	})
	it('leaves the list alone when nothing can be launched', () => {
		expect(eagerToolsWithDelegation(eagerToolsFor({}), false)).toEqual(eagerToolsFor({}))
	})
})
