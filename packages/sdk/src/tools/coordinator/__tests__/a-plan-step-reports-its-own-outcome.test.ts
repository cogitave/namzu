import { describe, expect, it } from 'vitest'

import { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { RunId, TaskId } from '../../../types/ids/index.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * A plan's steps had no relationship to the work that carried them out.
 *
 * `approve_plan` built steps, `create_task` launched workers, and nothing
 * connected the two — so no step could ever be observed, `updateStepStatus` had
 * no production caller, and a plan could reach `failed` (the error path calls
 * `failPlan`) or sit at `executing` forever, but never `completed`.
 *
 * Two bindings close it, because there are two kinds of step. A DELEGATED step
 * reports through the `create_task` that carries it out. An ORCHESTRATOR-OWNED
 * step has no tool call to bind to at all, and reports through
 * `update_plan_step` — without which a plan containing one could never settle
 * however well it went.
 */

const RUN = 'run_step_binding' as RunId

function gatewayReturning(outcome: 'ok' | 'failed'): TaskScheduler {
	const handle = (taskId: TaskId): TaskHandle => ({
		taskId,
		agentId: 'worker',
		state: 'completed',
		createdAt: 1_000,
		completedAt: 2_000,
		result: (outcome === 'ok'
			? { status: 'completed', result: 'the work' }
			: { status: 'failed', lastError: 'the worker died' }) as TaskHandle['result'],
	})
	return {
		async createTask() {
			return handle('tsk_1' as TaskId)
		},
		async waitForTask(id) {
			return handle(id)
		},
		async continueTask() {},
		cancelTask() {},
		getTask(id) {
			return handle(id)
		},
		listTasks() {
			return []
		},
		onTaskCompleted() {
			return () => {}
		},
	}
}

function ctx(): ToolContext {
	return {
		runId: RUN,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** An approved two-step plan: one delegated, one the orchestrator's own. */
function approvedPlan(): PlanManager {
	const pm = new PlanManager(RUN, async () => ({ approved: true }))
	pm.startGenerating('do the work')
	pm.addStep({
		id: 'step_1',
		description: 'delegated work',
		agentId: 'worker',
		dependsOn: [],
		order: 1,
	})
	pm.addStep({ id: 'step_2', description: 'my own work', dependsOn: [], order: 2 })
	pm.markReady()
	pm.approve()
	pm.startExecution()
	return pm
}

function toolsOver(pm: PlanManager, gateway: TaskScheduler): (name: string) => ToolDefinition {
	const tools = buildCoordinatorTools({
		gateway,
		workingDirectory: '/tmp/test',
		allowedAgentIds: ['worker'],
		getPlanManager: () => pm,
	})
	return (name: string) => {
		const t = tools.find((tool) => tool.name === name)
		if (!t) throw new Error(`${name} missing from coordinator builder`)
		return t
	}
}

const stepStatus = (pm: PlanManager, id: string) =>
	pm.active?.steps.find((s) => s.id === id)?.status

describe('a delegated step reports through the launch that carries it out', () => {
	it('carries the plan edge on the live worker launch', async () => {
		const pm = approvedPlan()
		const gateway = gatewayReturning('ok')
		let launched: Parameters<TaskScheduler['createTask']>[0] | undefined
		const createTask = gateway.createTask.bind(gateway)
		gateway.createTask = async (options) => {
			launched = options
			return createTask(options)
		}
		const named = toolsOver(pm, gateway)

		await named('create_task').execute(
			{ agent_id: 'worker', prompt: 'go', description: 'do it', plan_step_id: 'step_1' },
			ctx(),
		)

		expect(launched).toMatchObject({ planId: pm.active?.id, planStepId: 'step_1' })
	})

	it('completes the step when the worker succeeded', async () => {
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		await named('create_task').execute(
			{ agent_id: 'worker', prompt: 'go', description: 'do it', plan_step_id: 'step_1' },
			ctx(),
		)

		expect(stepStatus(pm, 'step_1')).toBe('completed')
	})

	it('fails the step when the worker failed, from both authorities', async () => {
		// The handle is `state: 'completed'` with `result.status: 'failed'` —
		// the split that made a failed worker read as an answer. The step must
		// follow the run status, not the gateway state.
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('failed'))

		await named('create_task').execute(
			{ agent_id: 'worker', prompt: 'go', description: 'do it', plan_step_id: 'step_1' },
			ctx(),
		)

		expect(stepStatus(pm, 'step_1')).toBe('failed')
	})

	it('leaves the plan alone when the launch names no step', async () => {
		// A launch outside the approved plan must not silently settle one.
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		await named('create_task').execute(
			{ agent_id: 'worker', prompt: 'go', description: 'unrelated work' },
			ctx(),
		)

		expect(stepStatus(pm, 'step_1')).toBe('pending')
	})
})

describe('an orchestrator-owned step reports through update_plan_step', () => {
	it('records the outcome and says what is still outstanding', async () => {
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		const result = await named('update_plan_step').execute(
			{ step_id: 'step_2', status: 'completed' },
			ctx(),
		)

		expect(result.success).toBe(true)
		expect(stepStatus(pm, 'step_2')).toBe('completed')
		// step_1 has not reported, and saying so is the point — this is what
		// tells the model the plan cannot settle yet.
		expect(result.output).toContain('step_1')
	})

	it('treats skipped as a real outcome, not a failure', async () => {
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		await named('update_plan_step').execute({ step_id: 'step_2', status: 'skipped' }, ctx())

		expect(stepStatus(pm, 'step_2')).toBe('skipped')
	})

	it('refuses an id the plan does not have, and names the ones it does', async () => {
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		const result = await named('update_plan_step').execute(
			{ step_id: 'step_9', status: 'completed' },
			ctx(),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('step_1')
		expect(result.error).toContain('step_2')
	})
})

describe('the two bindings together let a plan settle', () => {
	it('reaches completed once every step has reported', async () => {
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		await named('create_task').execute(
			{ agent_id: 'worker', prompt: 'go', description: 'do it', plan_step_id: 'step_1' },
			ctx(),
		)
		await named('update_plan_step').execute({ step_id: 'step_2', status: 'completed' }, ctx())

		expect(pm.unreportedSteps).toHaveLength(0)
		expect(pm.completePlan()?.status).toBe('completed')
	})

	it('leaves the plan unsettled while a step is still silent', async () => {
		// The state the kernel reads before deciding whether to settle. An
		// unreported step means the caller and the plan disagree about whether
		// the work is over, and the run must not resolve that by guessing.
		const pm = approvedPlan()
		const named = toolsOver(pm, gatewayReturning('ok'))

		await named('create_task').execute(
			{ agent_id: 'worker', prompt: 'go', description: 'do it', plan_step_id: 'step_1' },
			ctx(),
		)

		expect(pm.unreportedSteps.map((s) => s.id)).toEqual(['step_2'])
	})
})
