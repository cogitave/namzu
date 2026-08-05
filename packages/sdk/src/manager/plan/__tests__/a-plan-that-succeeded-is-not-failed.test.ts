import { describe, expect, it } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
import { PlanManager } from '../lifecycle.js'

/**
 * `completePlan` scored an unreported step as a failure.
 *
 * The test was "is every step completed or skipped", and everything else fell
 * to the same branch — so a step still `pending` produced `failed`. Since
 * `addStep` defaults every step to `pending`, a caller that added steps, did
 * the work, and settled the plan without reporting each one got `failed` for a
 * plan that had fully succeeded. That is the path of least effort, not an
 * unusual one.
 *
 * A step that FAILED is an outcome. A step nobody reported on is not — it says
 * the caller and the plan disagree about whether the work is over, and
 * answering "failed" settles that by inventing a result.
 */

const RUN = 'run_plan_outcome' as RunId

function planWithSteps(count: number): PlanManager {
	const manager = new PlanManager(RUN)
	manager.startGenerating('a plan')
	for (let i = 0; i < count; i += 1) {
		manager.addStep({
			id: `step-${i + 1}`,
			description: `step ${i + 1}`,
			dependsOn: [],
			order: i,
		})
	}
	manager.markReady()
	return manager
}

describe('a plan settles on what its steps actually reported', () => {
	it('completes when every step reported success', () => {
		const manager = planWithSteps(2)
		for (const step of manager.active?.steps ?? []) {
			manager.updateStepStatus(step.id, 'completed')
		}

		expect(manager.completePlan()?.status).toBe('completed')
	})

	it('counts a skipped step as settled, not as a failure', () => {
		const manager = planWithSteps(2)
		const steps = manager.active?.steps ?? []
		manager.updateStepStatus(steps[0]?.id as string, 'completed')
		manager.updateStepStatus(steps[1]?.id as string, 'skipped')

		expect(manager.completePlan()?.status).toBe('completed')
	})

	it('fails when a step actually failed', () => {
		const manager = planWithSteps(2)
		const steps = manager.active?.steps ?? []
		manager.updateStepStatus(steps[0]?.id as string, 'completed')
		manager.updateStepStatus(steps[1]?.id as string, 'failed')

		expect(manager.completePlan()?.status).toBe('failed')
	})

	it('refuses rather than scoring a step nobody reported on', () => {
		// The defect, in the shape a caller reaches it: steps added, work done,
		// nothing reported. Answering `failed` here is the invented result.
		const manager = planWithSteps(2)
		manager.updateStepStatus(manager.active?.steps[0]?.id as string, 'completed')

		expect(() => manager.completePlan()).toThrow(/have not reported an outcome/)
	})

	it('names the way out rather than only the refusal', () => {
		// A caller in this position either forgot to report progress or called
		// too early, and only they know which — so the message has to carry
		// both moves, not just the complaint.
		const manager = planWithSteps(1)

		expect(() => manager.completePlan()).toThrow(/updateStepStatus/)
		expect(() => manager.completePlan()).toThrow(/failPlan/)
	})

	it('still returns null when there is no plan at all', () => {
		expect(new PlanManager(RUN).completePlan()).toBeNull()
	})
})
