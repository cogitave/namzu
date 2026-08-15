import { describe, expect, it } from 'vitest'

import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The plan stream stopped one event short of the outcome.
 *
 * `plan_ready`, `plan_approved`, `plan_rejected` and `plan_step_updated` all
 * reached the wire; `plan.completed` and `plan.failed` were folded into a bare
 * `break` in the translator and emitted nothing. So a host watching the stream
 * saw the steps report and then silence — it could learn a plan had been
 * approved and never that it closed, which leaves a plan rendered as in-flight
 * indefinitely.
 *
 * **This was found by a live end-to-end run, not by a test, and that is the
 * point worth keeping.** The settlement tests read the outcome off
 * `PlanManager` through `onContextCreated`, so they proved the plan settled
 * without ever asking whether a consumer of the EVENT STREAM could see it. A
 * verification can be entirely sound about a thing that is no longer the thing
 * you need to know.
 */

registerMock()

async function runWithPlan(seed: (pm: PlanManager) => void): Promise<RunEvent[]> {
	const events: RunEvent[] = []

	await drainQuery(
		{
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
			onContextCreated: ({ planManager }: { planManager: PlanManager }) => seed(planManager),
		},
		(event: RunEvent) => {
			events.push(event)
		},
	)

	return events
}

function twoStepPlan(pm: PlanManager): void {
	pm.startGenerating('the work')
	pm.addStep({ id: 'step_1', description: 'first', dependsOn: [], order: 1 })
	pm.addStep({ id: 'step_2', description: 'second', dependsOn: [], order: 2 })
	pm.markReady()
	pm.approve()
	pm.startExecution()
}

const typesOf = (events: RunEvent[]) => events.map((e) => e.type)

describe('a settled plan says so on the run stream', () => {
	it('emits plan_completed when the run settles a successful plan', async () => {
		const events = await runWithPlan((p) => {
			twoStepPlan(p)
			p.updateStepStatus('step_1', 'completed')
			p.updateStepStatus('step_2', 'skipped')
		})

		expect(typesOf(events)).toContain('plan_completed')
	})

	it('emits plan_failed, carrying the reason failPlan was given', async () => {
		// `failPlan` took this argument and discarded it — the parameter was
		// spelled `_error`. An event that says "failed" without saying why puts
		// the reader back where the missing event did.
		const events = await runWithPlan((p) => {
			twoStepPlan(p)
			p.failPlan('the provider refused the request')
		})

		const failed = events.find((e) => e.type === 'plan_failed')
		expect(failed).toBeDefined()
		expect((failed as { reason?: string }).reason).toBe('the provider refused the request')
	})

	it('emits plan_failed when a step actually failed', async () => {
		const events = await runWithPlan((p) => {
			twoStepPlan(p)
			p.updateStepStatus('step_1', 'completed')
			p.updateStepStatus('step_2', 'failed')
		})

		expect(typesOf(events)).toContain('plan_failed')
		expect(typesOf(events)).not.toContain('plan_completed')
	})

	it('says nothing terminal while a step has not reported', async () => {
		// The plan is genuinely unsettled, so the silence here is correct — it
		// is the silence AFTER settlement that was the defect.
		const events = await runWithPlan((p) => {
			twoStepPlan(p)
			p.updateStepStatus('step_1', 'completed')
		})

		expect(typesOf(events)).not.toContain('plan_completed')
		expect(typesOf(events)).not.toContain('plan_failed')
		// ...and the step that DID report is still announced, so this is not a
		// stream that has simply gone quiet.
		expect(typesOf(events)).toContain('plan_step_updated')
	})
})
