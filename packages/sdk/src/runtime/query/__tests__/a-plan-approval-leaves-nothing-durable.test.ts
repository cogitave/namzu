import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import type { RunStateScope } from '../run-state.js'

/**
 * The `plan_approval` arm of the HITL union is answered live and recorded
 * nowhere, and this is what that means in practice.
 *
 * `index.ts` mints a `CheckpointId` for every plan review and threads it into
 * the request a human sees, which reads exactly like the durable parks the
 * tool review and the question channel write. Nothing ever writes it: there
 * is no `checkpointMgr.park` on this path, and no checkpoint in the store
 * ever carries `pending.request.type === 'plan_approval'`. So a plan approval
 * is not resumable, and `resumeRun` cannot report `awaiting-decision` for one
 * — not because the resume path is broken, but because there is nothing on
 * the record to find.
 *
 * The id is pinned as well as the absence: it is a real, well-formed
 * checkpoint id that no store has ever seen, and a reader who saw it on a
 * request would reasonably assume otherwise. Reported as a defect on its own
 * track; the refactor must not change either half of this silently.
 */

const SCOPE: RunStateScope = {
	runId: fixtureId.run('plan-approval'),
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	topicId: generateTopicId(),
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function runToPlanApproval(): Promise<{
	store: InMemoryCheckpointStore
	requests: HITLDecisionRequest[]
	approvals: boolean[]
	plans: PlanManager
}> {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-plan-approval-'))
	dirs.push(workingDirectory)
	const store = new InMemoryCheckpointStore()
	const requests: HITLDecisionRequest[] = []
	const approvals: boolean[] = []
	let planManager: PlanManager | undefined

	await drainQuery(
		{
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools: new ToolRegistry(),
			checkpointStore: store,
			agentId: 'agent_plan_approval',
			agentName: 'Plan approval agent',
			messages: [createUserMessage('make a plan')],
			workingDirectory,
			runId: SCOPE.runId,
			tenantId: SCOPE.tenantId,
			projectId: SCOPE.projectId,
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			resumeHandler: async (request: HITLDecisionRequest) => {
				if (request.type === 'plan_approval') {
					requests.push(request)
					approvals.push(true)
					return { action: 'approve_plan' }
				}
				return { action: 'continue' }
			},
			onContextCreated: ({ planManager: manager }: { planManager: PlanManager }) => {
				planManager = manager
			},
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 2,
				maxResponseTokens: 256,
			},
		} as unknown as QueryParams,
		(_event) => {},
	)

	if (!planManager) throw new Error('the run did not create a plan manager')
	return { store, requests, approvals, plans: planManager }
}

describe('a plan approval reaching a human', () => {
	it('is delivered with a plan, an id, and the answer applied', async () => {
		const { requests, approvals, plans } = await runToPlanApproval()

		// The plan manager outlives the run, so a review raised after it
		// returned is the same wiring a run-time review takes.
		plans.startGenerating('first plan')
		plans.addStep({ id: 'step_1', description: 'the work', dependsOn: [], order: 1 })
		plans.markReady()
		const response = await plans.requestApproval()

		expect(requests).toHaveLength(1)
		expect(approvals).toEqual([true])
		expect(response.approved).toBe(true)
		const planRequest = requests[0]
		expect(planRequest?.type).toBe('plan_approval')
		if (planRequest?.type !== 'plan_approval') return
		expect(planRequest.plan.steps.map((step) => step.description)).toEqual(['the work'])
		expect(planRequest.plan.title).toBe('first plan')
		// A well-formed checkpoint id, and the reason this file exists: it
		// names a checkpoint that no store has ever been asked to hold.
		expect(planRequest.checkpointId).toMatch(/^[0-9a-f-]{36}$/)
	})

	it('leaves no durable park, so there is nothing for a resume to find', async () => {
		const { store, requests, plans } = await runToPlanApproval()

		plans.startGenerating('a plan nobody can resume from')
		plans.addStep({ id: 'step_1', description: 'the work', dependsOn: [], order: 1 })
		plans.markReady()
		await plans.requestApproval()
		expect(requests).toHaveLength(1)

		const checkpoints = await store.listCheckpoints(SCOPE)
		// PINNED, AND THE GAP ITSELF: no checkpoint in the store carries a
		// plan-approval park — so a run that died between asking and being
		// answered leaves no record of the question at all.
		expect(checkpoints.some((cp) => cp.pending?.request.type === 'plan_approval')).toBe(false)
		expect(await findPendingCheckpoint(store, SCOPE)).toBeNull()
		// The id the human was shown is not in the store under that scope or
		// any other: `requestApproval` awaits the handler and writes nothing.
		expect(checkpoints.some((checkpoint) => checkpoint.id === requests[0]?.checkpointId)).toBe(
			false,
		)
	})
})
