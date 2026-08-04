import { describe, expect, it } from 'vitest'
import type { TaskGateway } from '../../../types/agent/gateway.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * `create_task` used to widen its `agent_id` parameter from the roster enum to
 * a bare string whenever the roster was empty — so the one configuration that
 * says "this run may delegate to nobody" was the one that let the model name
 * anybody. An allow-list that admits everything when it is empty is the
 * fail-safe-defaults violation Saltzer & Schroeder named in 1975 (§3.A.2) and
 * the defect catalogued as CWE-183.
 *
 * The refusal has to land here rather than downstream: an unknown id reaching
 * the agent registry fails with "no such agent", which sends whoever reads it
 * looking for a missing registration instead of an empty roster.
 */

const gateway = {
	dispatch: async () => {
		throw new Error('gateway must not be reached — the schema refuses first')
	},
	listTasks: () => [],
	cancel: () => undefined,
} as unknown as TaskGateway

function createTaskFor(allowedAgentIds: string[]) {
	const tool = buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds,
	}).find((t) => t.name === 'create_task')
	if (!tool) throw new Error('create_task missing from coordinator builder')
	return tool
}

describe('create_task delegate roster', () => {
	it('refuses every agent id when the roster is empty', () => {
		const parsed = createTaskFor([]).inputSchema.safeParse({
			agent_id: 'anything-at-all',
			prompt: 'do the thing',
			description: 'a task',
		})

		expect(parsed.success).toBe(false)
		if (parsed.success) return
		expect(JSON.stringify(parsed.error.issues)).toContain('no delegates configured')
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
