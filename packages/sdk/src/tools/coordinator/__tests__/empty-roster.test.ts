import { describe, expect, it } from 'vitest'
import type { TaskScheduler } from '../../../types/agent/scheduler.js'
import { buildAgentTool } from '../agent.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * `create_task` used to widen its `agent_id` parameter from the roster enum to
 * a bare string whenever the roster was empty — so the one configuration that
 * says "this run may delegate to nobody" was the one that let the model name
 * anybody. Degrading a closed list to an open one because the list is empty is
 * failing open (CWE-636), and Saltzer & Schroeder named the rule it breaks in
 * 1975: fail-safe defaults, §I.A.3(b).
 *
 * The control is that the tool is not mounted at all — refusing per call would
 * reach the same verdict while paying prompt tokens and an iteration for it.
 * The schema stays closed underneath as defence-in-depth for a definition
 * built directly.
 *
 * What was reachable before is worth stating, because it is why this is a
 * break worth taking: the id went to the gateway, which resolves against an
 * `AgentManager` that is typically SHARED — so a name the host deliberately
 * left out of `agentIds` could still launch if it happened to be registered
 * there.
 */

const gateway = {
	dispatch: async () => {
		throw new Error('gateway must not be reached — the schema refuses first')
	},
	listTasks: () => [],
	cancel: () => undefined,
} as unknown as TaskScheduler

function toolsFor(allowedAgentIds: string[], resumeHandler?: unknown) {
	return buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds,
		...(resumeHandler ? { resumeHandler: resumeHandler as never, runId: 'run_1' as never } : {}),
	})
}

function createTaskFor(allowedAgentIds: string[]) {
	const tool = toolsFor(allowedAgentIds).find((t) => t.name === 'create_task')
	if (!tool) throw new Error('create_task missing from coordinator builder')
	return tool
}

describe('create_task delegate roster', () => {
	it('does not mount create_task at all when the roster is empty', () => {
		const names = toolsFor([]).map((t) => t.name)

		expect(names).not.toContain('create_task')
	})

	it('still mounts the coordinator tools that do not read the roster', () => {
		// "No delegates, but still planning and a human channel" is a
		// supported configuration, so this omits one tool rather than
		// refusing to build.
		const names = toolsFor([], async () => ({ action: 'approve_tools' })).map((t) => t.name)

		expect(names).toContain('agent_task_list')
		expect(names).toContain('ask_user_question')
	})

	it('mounts create_task once the roster has an entry', () => {
		expect(toolsFor(['worker']).map((t) => t.name)).toContain('create_task')
	})

	it('still admits an id that is on a non-empty roster', () => {
		const parsed = createTaskFor(['worker']).inputSchema.safeParse({
			agent_id: 'worker',
			prompt: 'do the thing',
			description: 'a task',
		})

		expect(parsed.success).toBe(true)
	})

	it('still refuses an id that is off a non-empty roster', () => {
		const parsed = createTaskFor(['worker']).inputSchema.safeParse({
			agent_id: 'some-other-agent',
			prompt: 'do the thing',
			description: 'a task',
		})

		expect(parsed.success).toBe(false)
	})
})

describe('the Agent tool carries the same closed roster', () => {
	it('refuses to build at all with no delegates', () => {
		// Unlike the coordinator builder, this one returns exactly one tool
		// and that tool IS the delegation surface, so "do not mount" and "do
		// not build" are the same statement.
		expect(() =>
			buildAgentTool({ gateway, workingDirectory: '/tmp/test', allowedAgentIds: [] }),
		).toThrow(/at least one entry in allowedAgentIds/)
	})

	it('refuses an off-roster subagent at execution, not only in the schema', async () => {
		// `execute` is reachable without the registry, so a schema-only check
		// leaves the roster unenforced on that path.
		const tool = buildAgentTool({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['worker'],
		})

		const result = await tool.execute(
			{ description: 'x', prompt: 'y', subagent_type: 'not-on-the-roster' },
			{ workingDirectory: '/tmp/test' } as never,
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/Unknown subagent_type/)
	})
})
