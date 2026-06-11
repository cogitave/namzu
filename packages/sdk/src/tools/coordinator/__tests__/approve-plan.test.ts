import { describe, expect, it } from 'vitest'

import { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { TaskGateway } from '../../../types/agent/gateway.js'
import type { RunId } from '../../../types/ids/index.js'
import type { PlanApprovalResponse } from '../../../types/plan/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
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

function testToolContext(): ToolContext {
	return {
		runId: 'run_approve_plan_test' as RunId,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function executeApprovePlan(approval: PlanApprovalResponse) {
	const pm = new PlanManager('run_approve_plan_test' as RunId, async () => approval)
	const tools = buildCoordinatorTools({
		gateway: unusedGateway(),
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['sales-strategy'],
		getPlanManager: () => pm,
	})

	const approvePlan = tools.find((tool) => tool.name === 'approve_plan')
	if (!approvePlan) throw new Error('approve_plan tool missing from coordinator builder')

	return approvePlan.execute(
		{
			title: 'Review uploaded documents',
			summary: 'Inspect the documents and prepare the worker plan.',
			steps: [{ description: 'Extract uploaded DOCX files' }],
		},
		testToolContext(),
	)
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

	it('keeps the bare-approve tool_result output byte-identical', async () => {
		const result = await executeApprovePlan({ approved: true })

		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'Plan approved by user. Proceed with execution — launch workers via create_task.',
		)
		expect(result.data).toEqual({ approved: true, feedback: undefined })
	})

	it('embeds approve-with-edits feedback in the output and data', async () => {
		const result = await executeApprovePlan({
			approved: true,
			feedback: 'Skip step 2 and use the staging database instead.',
		})

		expect(result.success).toBe(true)
		expect(result.output).toBe(
			'Plan approved by user with required edits — apply them during execution:\n' +
				'Skip step 2 and use the staging database instead.\n' +
				'Proceed with execution — launch workers via create_task.',
		)
		expect(result.data).toEqual({
			approved: true,
			feedback: 'Skip step 2 and use the staging database instead.',
		})
	})

	it('keeps the rejection output carrying the feedback verbatim with follow-the-feedback guidance', async () => {
		const result = await executeApprovePlan({
			approved: false,
			feedback: 'Wrong scope — focus on invoices only',
		})

		expect(result.success).toBe(false)
		// Guidance must FOLLOW the feedback rather than bake in a revise
		// loop — stop-style feedback ("do not plan again") and a trailing
		// "revise and call approve_plan again" are contradictory
		// instructions, and the model kept generating plans after a
		// rejection meant to halt.
		expect(result.output).toBe(
			'Plan rejected. User feedback: Wrong scope — focus on invoices only. Follow this feedback: if it requests changes, revise your plan and call approve_plan again; if it asks you to stop, acknowledge briefly and end your turn. If no feedback was provided, ask the user how to proceed before planning again.',
		)
		expect(result.data).toEqual({
			approved: false,
			feedback: 'Wrong scope — focus on invoices only',
		})
	})
})
