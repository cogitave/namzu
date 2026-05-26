import { describe, expect, it } from 'vitest'

import type { TaskGateway } from '../../../types/agent/gateway.js'
import { buildCoordinatorTools } from '../index.js'

function unusedGateway(): TaskGateway {
	return {
		async createTask() {
			throw new Error('not used')
		},
		async waitForTask() {
			throw new Error('not used')
		},
		async continueTask() {},
		cancelTask() {},
		getTask() {
			return undefined
		},
		listTasks() {
			return []
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

describe('coordinator approve_plan tool', () => {
	it('normalizes plain-text plan steps into canonical step objects', () => {
		const tools = buildCoordinatorTools({
			gateway: unusedGateway(),
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['sales-strategy'],
			getPlanManager: () => undefined,
		})

		const approvePlan = tools.find((tool) => tool.name === 'approve_plan')
		if (!approvePlan) throw new Error('approve_plan tool missing from coordinator builder')

		const parsed = approvePlan.inputSchema.safeParse({
			title: 'Review uploaded documents',
			summary: 'Inspect the documents and prepare the worker plan.',
			steps: '1. Extract uploaded DOCX files\n2. Launch architecture worker',
		})

		expect(parsed.success).toBe(true)
		if (!parsed.success) return
		const data = parsed.data as { steps: Array<{ description: string }> }
		expect(data.steps).toEqual([
			{ description: 'Extract uploaded DOCX files' },
			{ description: 'Launch architecture worker' },
		])
	})
})
