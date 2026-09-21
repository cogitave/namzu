import type { HITLDecisionRequest } from '../../../../types/hitl/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import {
	type IterationContext,
	type PhaseSignal,
	awaitDecisionOrAbort,
	handleHITLDecision,
} from './context.js'

export async function* runPlanGate(
	ctx: IterationContext,
): AsyncGenerator<SessionEvent, PhaseSignal> {
	if (!ctx.planManager.active || ctx.planManager.active.status !== 'ready') {
		return 'continue'
	}

	const planCheckpoint = await ctx.checkpointMgr.create(ctx.recorder, 0)

	await ctx.emitEvent({
		type: 'checkpoint_created',
		turnId: ctx.recorder.turnId,
		checkpointId: planCheckpoint.id,
		iteration: 0,
	})
	yield* ctx.drainPending()

	const plan = ctx.planManager.active
	const request: HITLDecisionRequest = {
		type: 'plan_approval',
		sessionId: ctx.recorder.sessionId,
		turnId: ctx.recorder.turnId,
		checkpointId: planCheckpoint.id,
		plan: {
			planId: plan.id,
			title: plan.title,
			steps: plan.steps.map((s) => ({
				id: s.id,
				description: s.description,
				toolName: s.toolName,
				agentId: s.agentId,
				dependsOn: s.dependsOn,
				order: s.order,
			})),
			summary: plan.summary,
		},
	}

	// Record the park BEFORE awaiting it. A process that dies while a human
	// is reading the plan otherwise leaves nothing behind saying the plan
	// was ever put up for approval.
	//
	// The park stays eager — `awaitDecisionDurably` records only after
	// `PARK_RECORD_DELAY_MS`, which is the right trade for a gate that runs
	// on every iteration and the wrong one for a gate that runs once and is
	// read by a human. Only the AWAIT below is raced.
	await ctx.checkpointMgr.park(planCheckpoint, request)
	// Raced against the turn's abort signal, like every other park. A bare
	// `await ctx.resumeHandler(request)` here meant a Stop did nothing until
	// the host answered: `runPlanGate` runs in the iteration loop rather than
	// inside a tool call, so nothing downstream bounded the wait. A Stop now
	// resolves the park as `abort`, which `handleHITLDecision` turns into
	// `setStopReason('cancelled') + markCancelled + stop`.
	const planDecision = await awaitDecisionOrAbort(ctx, request)
	await ctx.checkpointMgr.unpark(planCheckpoint.id, planDecision)

	return yield* handleHITLDecision(ctx, planDecision, planCheckpoint.id, 'plan_gate')
}
