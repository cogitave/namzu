import type { HITLDecisionRequest } from '../../../../types/hitl/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import { generateDecisionRequestId } from '../../../../utils/id.js'
import { CheckpointManager } from '../../checkpoint.js'
import { type IterationContext, type PhaseSignal, handleHITLDecision } from './context.js'

export async function* runIterationCheckpoint(
	ctx: IterationContext,
	iterationNum: number,
): AsyncGenerator<RunEvent, PhaseSignal> {
	const iterCheckpoint = await ctx.checkpointMgr.create(
		ctx.runMgr,
		iterationNum,
		ctx.guard.activeElapsedMs,
	)

	await ctx.emitEvent({
		type: 'checkpoint_created',
		runId: ctx.runMgr.id,
		checkpointId: iterCheckpoint.id,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const summary = CheckpointManager.buildSummary(ctx.runMgr, iterationNum)
	const request: HITLDecisionRequest = {
		type: 'iteration_checkpoint',
		requestId: generateDecisionRequestId(),
		runId: ctx.runMgr.id,
		checkpointId: iterCheckpoint.id,
		summary,
	}
	const iterDecision = await ctx.resumeHandler(request)

	return yield* handleHITLDecision(ctx, iterDecision, request, 'iteration_checkpoint')
}
