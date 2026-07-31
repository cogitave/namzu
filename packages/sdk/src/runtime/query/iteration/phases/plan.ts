import type { HITLDecisionRequest } from '../../../../types/hitl/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import { type IterationContext, type PhaseSignal, handleHITLDecision } from './context.js'

export async function* runPlanGate(ctx: IterationContext): AsyncGenerator<RunEvent, PhaseSignal> {
	if (!ctx.planManager.active || ctx.planManager.active.status !== 'ready') {
		return 'continue'
	}

	const planCheckpoint = await ctx.checkpointMgr.create(ctx.runMgr, 0)

	await ctx.emitEvent({
		type: 'checkpoint_created',
		runId: ctx.runMgr.id,
		checkpointId: planCheckpoint.id,
		iteration: 0,
	})
	yield* ctx.drainPending()

	const plan = ctx.planManager.active
	const request: HITLDecisionRequest = {
		type: 'plan_approval',
		runId: ctx.runMgr.id,
		checkpointId: planCheckpoint.id,
		plan: {
			planId: plan.id,
			title: plan.title,
			steps: plan.steps.map((s) => ({
				id: s.id,
				description: s.description,
				toolName: s.toolName,
				dependsOn: s.dependsOn,
				order: s.order,
			})),
			summary: plan.summary,
		},
	}

	// Record the park BEFORE awaiting it. A process that dies while a human
	// is reading the plan otherwise leaves nothing behind saying the plan
	// was ever put up for approval.
	await ctx.checkpointMgr.park(planCheckpoint, request)
	const planDecision = await ctx.resumeHandler(request)
	await ctx.checkpointMgr.unpark(planCheckpoint.id, planDecision)

	return yield* handleHITLDecision(ctx, planDecision, planCheckpoint.id, 'plan_gate')
}
