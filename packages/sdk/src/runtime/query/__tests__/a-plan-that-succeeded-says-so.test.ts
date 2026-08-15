import { describe, expect, it } from 'vitest'

import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * Nothing settled a plan that SUCCEEDED.
 *
 * The error path calls `failPlan`, so a run that blew up said so. The success
 * path never touched the plan manager at all — so a plan could reach `failed`
 * or sit at `executing` forever, but never `completed`. A host reading
 * `plan.status` after a successful run was told the work was still going.
 *
 * Settlement is conditional on every step having reported, and the condition is
 * read rather than caught: `completePlan` refuses an unreported step on
 * purpose, and letting that throw here would turn a run that worked into a run
 * that crashed on its way out — a worse version of the bug the refusal exists
 * to prevent.
 */

registerMock()

/** Run to completion, with a plan seeded through the host's own seam. */
async function runWithPlan(seed: (pm: PlanManager) => void): Promise<PlanManager> {
	let captured: PlanManager | undefined

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
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		// The documented host seam: `drainQuery` hands the plan manager over
		// BEFORE the iteration loop, which is exactly what makes a host-driven
		// plan possible at all.
		onContextCreated: ({ planManager }: { planManager: PlanManager }) => {
			captured = planManager
			seed(planManager)
		},
	})

	if (!captured) throw new Error('onContextCreated never fired')
	return captured
}

function twoStepPlan(pm: PlanManager): void {
	pm.startGenerating('the work')
	pm.addStep({ id: 'step_1', description: 'first', dependsOn: [], order: 1 })
	pm.addStep({ id: 'step_2', description: 'second', dependsOn: [], order: 2 })
	pm.markReady()
	pm.approve()
	pm.startExecution()
}

describe('a run that succeeded settles the plan it was executing', () => {
	it('reports completed when every step reported', async () => {
		const pm = await runWithPlan((p) => {
			twoStepPlan(p)
			p.updateStepStatus('step_1', 'completed')
			p.updateStepStatus('step_2', 'skipped')
		})

		expect(pm.active?.status).toBe('completed')
	})

	it('reports failed when a step actually failed', async () => {
		const pm = await runWithPlan((p) => {
			twoStepPlan(p)
			p.updateStepStatus('step_1', 'completed')
			p.updateStepStatus('step_2', 'failed')
		})

		expect(pm.active?.status).toBe('failed')
	})

	it('leaves it executing — and does not throw — when a step never reported', async () => {
		// The honest answer. The caller and the plan disagree about whether the
		// work is over, and the end of a successful run is not the place to
		// resolve that by guessing. The run itself must still finish cleanly,
		// which is the half that would break if the refusal were caught here
		// instead of checked.
		const pm = await runWithPlan((p) => {
			twoStepPlan(p)
			p.updateStepStatus('step_1', 'completed')
		})

		expect(pm.active?.status).toBe('executing')
	})

	it('does nothing when the run had no plan at all', async () => {
		const pm = await runWithPlan(() => {})

		expect(pm.active).toBeNull()
	})
})
