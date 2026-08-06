import { describe, expect, it } from 'vitest'

import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { HITLResumeDecision, PlanApprovalData } from '../../../types/hitl/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * There are TWO approval surfaces, and the fix landed on one of them.
 *
 * `PlanStep.agentId` was added so an approver could see WHICH agent a step goes
 * to rather than only THAT it delegates. It reached `PlanApprovalRequest` — the
 * shape a host sees when it installs its own handler on `PlanManager` — and the
 * test written at the time asserted on exactly that, by constructing a
 * `PlanManager` directly.
 *
 * It did not reach `PlanApprovalData`, which is what every `resumeHandler` host
 * receives, because that type declared its own step shape and both mappers copy
 * field by field. So the busier surface kept showing `toolName: 'create_task'`
 * and nothing else — the precise behaviour the change was supposed to end.
 *
 * A live run did not catch it either: the run observes `plan_ready`, which
 * carries whole `PlanStep`s and therefore always had `agentId`. Watching the
 * event stream confirmed the field existed somewhere, which is not the same
 * question as whether the approver gets it.
 */

registerMock()

async function agentIdSeenByResumeHandler(): Promise<PlanApprovalData['steps']> {
	let seen: PlanApprovalData['steps'] | undefined

	await drainQuery({
		provider: new MockLLMProvider({ responses: [{ content: 'done' }] } as never),
		tools: new ToolRegistry(),
		agentId: 'a',
		agentName: 'A',
		messages: [{ role: 'user', content: 'go' }],
		workingDirectory: process.cwd(),
		runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 4 },
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		threadId: generateThreadId(),
		tenantId: generateTenantId(),
		// The ordinary host path: a resumeHandler, not a hand-installed
		// PlanManager handler.
		resumeHandler: async (request: { type: string; plan?: PlanApprovalData }) => {
			if (request.type === 'plan_approval' && request.plan) seen = request.plan.steps
			return { action: 'approve_plan' } as HITLResumeDecision
		},
		onContextCreated: ({ planManager }: { planManager: PlanManager }) => {
			planManager.startGenerating('the work')
			planManager.addStep({
				id: 'step_1',
				description: 'delegated work',
				agentId: 'shell-runner',
				toolName: 'create_task',
				dependsOn: [],
				order: 1,
			})
			planManager.addStep({ id: 'step_2', description: 'my own work', dependsOn: [], order: 2 })
			planManager.markReady()
			void planManager.requestApproval()
		},
	} as never)

	if (!seen) throw new Error('the resume handler never received a plan approval')
	return seen
}

describe('the resumeHandler approval surface names the agent too', () => {
	it('carries agentId through to the host', async () => {
		const steps = await agentIdSeenByResumeHandler()

		expect(steps.map((s) => s.agentId)).toEqual(['shell-runner', undefined])
	})

	it('still distinguishes the two steps by more than toolName', async () => {
		// The defect in the shape that matters: without agentId both delegated
		// steps reach the approver identical, and an orchestrator-owned step is
		// told apart only by an absent toolName.
		const steps = await agentIdSeenByResumeHandler()
		const delegated = steps.find((s) => s.id === 'step_1')

		expect(delegated?.toolName).toBe('create_task')
		expect(delegated?.agentId).toBe('shell-runner')
	})
})
