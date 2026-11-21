import { describe, expect, it } from 'vitest'

import { agentDetailMeta } from '../AgentExplorer.js'

const agent = {
	agentId: 'explore',
	model: 'anthropic/claude-haiku-5.5',
	status: 'completed',
	workflowRunId: undefined,
	usage: { outputTokens: 1200 },
} as never

describe('the meta of an agent row in the workflow view', () => {
	it('keeps every field when there is room', () => {
		const line = agentDetailMeta(agent, 100)
		expect(line).toContain('explore')
		expect(line).toContain('anthropic/claude')
	})

	it('drops whole fields when short of room, so no field is left as a bare ellipsis', () => {
		const full = agentDetailMeta(agent, 100)
		const cells = 30
		const line = agentDetailMeta(agent, 100, cells)
		expect([...line].length).toBeLessThanOrEqual(cells)
		expect(line).not.toMatch(/(^| · )…( · |$)/)
		expect(line.length).toBeLessThan(full.length)
		expect(line).toContain('claude-haiku')
	})
})
