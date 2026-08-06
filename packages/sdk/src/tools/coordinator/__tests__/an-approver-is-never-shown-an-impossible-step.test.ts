import { describe, expect, it } from 'vitest'

import { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { TaskGateway } from '../../../types/agent/gateway.js'
import type { RunId } from '../../../types/ids/index.js'
import type { PlanApprovalRequest } from '../../../types/plan/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { buildCoordinatorTools } from '../index.js'

/**
 * A plan could name an agent the launch would then refuse.
 *
 * `create_task` constrains `agent_id` with a closed enum; `approve_plan` typed
 * the same field as a bare string. So a model could propose, and a human could
 * approve, "delegate to X" for an X that `create_task` rejects at schema-parse
 * time — the run then burns a turn on a step a human had already blessed.
 *
 * The check lives in `execute`, not in the schema, and that is deliberate.
 * `approve_plan` is mounted even with an EMPTY roster, because planning with no
 * delegates and a human channel is a supported configuration — and `z.enum([])`
 * renders as `{"not":{}}`, the shape `delegateSchema` already refuses because a
 * strict tool-schema validator rejects the whole request over it rather than
 * the one tool. `create_task` escapes that by being withheld entirely; this
 * tool cannot be. Enforcing in `execute` as well is the precedent the canonical
 * `Agent` tool set for complete mediation.
 *
 * It runs BEFORE `startGenerating`, so the refusal costs no half-built plan and
 * the human is never shown the bad step at all.
 */

const RUN = 'run_roster' as RunId

function unusedGateway(): TaskGateway {
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

function ctx(): ToolContext {
	return {
		runId: RUN,
		workingDirectory: '/tmp/test',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** Run `approve_plan`, reporting both its result and what the approver saw. */
async function approve(
	roster: string[],
	steps: Array<{ description: string; agent_id?: string }>,
): Promise<{ result: Awaited<ReturnType<ReturnType<typeof build>>>; seen?: PlanApprovalRequest }> {
	let seen: PlanApprovalRequest | undefined
	const pm = new PlanManager(RUN, async (request) => {
		seen = request
		return { approved: true }
	})
	const run = build(roster, pm)
	const result = await run(steps)
	return { result, ...(seen ? { seen } : {}) }
}

function build(roster: string[], pm: PlanManager) {
	const tools = buildCoordinatorTools({
		gateway: unusedGateway(),
		workingDirectory: '/tmp/test',
		allowedAgentIds: roster,
		getPlanManager: () => pm,
	})
	const approvePlan = tools.find((t) => t.name === 'approve_plan')
	if (!approvePlan) throw new Error('approve_plan missing from coordinator builder')
	return (steps: Array<{ description: string; agent_id?: string }>) =>
		approvePlan.execute({ title: 'do it', summary: 'a plan', steps }, ctx())
}

describe('a plan may only name an agent the run can actually launch', () => {
	it('refuses a step naming an agent outside the roster', async () => {
		const { result } = await approve(
			['researcher', 'writer'],
			[{ description: 'audit the deps', agent_id: 'security-auditor' }],
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('security-auditor')
	})

	it('names the roster, so the model can correct itself in one turn', async () => {
		const { result } = await approve(
			['researcher', 'writer'],
			[{ description: 'audit', agent_id: 'nobody' }],
		)

		expect(result.error).toContain('researcher')
		expect(result.error).toContain('writer')
	})

	it('never shows the approver the step it refused', async () => {
		// The whole point of checking before `startGenerating`: a human must
		// not be asked to approve work that cannot run.
		const { seen } = await approve(
			['researcher'],
			[{ description: 'audit', agent_id: 'security-auditor' }],
		)

		expect(seen).toBeUndefined()
	})

	it('leaves no half-built plan behind', async () => {
		const pm = new PlanManager(RUN, async () => ({ approved: true }))
		const run = build(['researcher'], pm)

		await run([{ description: 'audit', agent_id: 'ghost' }])

		expect(pm.active).toBeNull()
	})

	it('says something different when the run has no delegates at all', async () => {
		// `approve_plan` is mounted on an empty roster on purpose — planning
		// without delegation is supported — so the message has to explain that
		// rather than list an empty set.
		const { result } = await approve([], [{ description: 'audit', agent_id: 'anyone' }])

		expect(result.success).toBe(false)
		expect(result.error).toContain('no delegates')
	})

	it('still admits a plan that delegates only within the roster', async () => {
		const { result, seen } = await approve(
			['researcher', 'writer'],
			[{ description: 'gather', agent_id: 'researcher' }, { description: 'summarize' }],
		)

		expect(result.success).toBe(true)
		expect(seen?.steps.map((s) => s.agentId)).toEqual(['researcher', undefined])
	})
})
