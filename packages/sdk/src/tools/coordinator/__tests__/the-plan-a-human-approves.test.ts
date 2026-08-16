import { describe, expect, it } from 'vitest'

import { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { TaskScheduler } from '../../../types/agent/scheduler.js'
import type { RunId } from '../../../types/ids/index.js'
import type { PlanApprovalRequest } from '../../../types/plan/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * The plan put in front of a human said a step delegates, never to whom.
 *
 * `approve_plan` asks the model for an `agent_id` per step — "which agent
 * handles this" — and reduced the answer to a boolean: the step got
 * `toolName: 'create_task'` when any agent was named and nothing when not. The
 * name itself was dropped between the model saying it and the human being
 * shown the plan.
 *
 * The approval is the one moment where that difference can still be acted on.
 * Approving "delegate this step" is not the same as approving "delegate this
 * step to the agent with shell access", and a reviewer who cannot see which
 * agent was chosen cannot withhold approval from the wrong one.
 */

const RUN = 'run_plan_approval' as RunId

function unusedGateway(): TaskScheduler {
	return {
		async createTask() {
			throw new Error('this test never launches')
		},
		async waitForTask() {
			throw new Error('this test never waits')
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
		runId: RUN,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** Run `approve_plan` and hand back exactly what the approver was shown. */
async function whatTheApproverSaw(
	steps: Array<{ description: string; agent_id?: string }>,
): Promise<PlanApprovalRequest> {
	let seen: PlanApprovalRequest | undefined
	const pm = new PlanManager(RUN, async (request) => {
		seen = request
		return { approved: true }
	})

	const tools = buildCoordinatorTools({
		gateway: unusedGateway(),
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['researcher', 'shell-runner'],
		getPlanManager: () => pm,
	})

	const approvePlan = tools.find((tool) => tool.name === 'approve_plan')
	if (!approvePlan) throw new Error('approve_plan tool missing from coordinator builder')

	await approvePlan.execute(
		{ title: 'Do the work', summary: 'A plan with delegated steps.', steps },
		testToolContext(),
	)

	if (!seen) throw new Error('the approval handler was never called')
	return seen
}

describe('the plan a human approves names the agent the model chose', () => {
	it('carries the agent per step, not just that there is one', async () => {
		const request = await whatTheApproverSaw([
			{ description: 'Gather the sources', agent_id: 'researcher' },
			{ description: 'Run the migration', agent_id: 'shell-runner' },
		])

		expect(request.steps.map((s) => s.agentId)).toEqual(['researcher', 'shell-runner'])
	})

	it('distinguishes two delegated steps that used to look identical', async () => {
		// The defect in the shape that matters: before this, both steps below
		// reached the approver as `toolName: 'create_task'` and nothing else, so
		// the one with shell access was indistinguishable from the one without.
		const request = await whatTheApproverSaw([
			{ description: 'Read the docs', agent_id: 'researcher' },
			{ description: 'Delete the old rows', agent_id: 'shell-runner' },
		])

		const [first, second] = request.steps
		expect(first?.toolName).toBe(second?.toolName)
		expect(first?.agentId).not.toBe(second?.agentId)
	})

	it('leaves an orchestrator-owned step unattributed', async () => {
		// Omitting `agent_id` means the orchestrator does it itself. That has to
		// stay distinguishable from delegation, so absent stays absent rather
		// than becoming a placeholder name.
		const request = await whatTheApproverSaw([{ description: 'Summarize what came back' }])

		expect(request.steps[0]?.agentId).toBeUndefined()
		expect(request.steps[0]?.toolName).toBeUndefined()
	})
})
