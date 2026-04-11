import type { RunEvent } from '../../../../types/run/index.js'
import { CheckpointManager } from '../../checkpoint.js'
import type { IterationContext, PhaseSignal } from './context.js'
import { handleHITLDecision } from './context.js'

export async function* runIterationCheckpoint(
	ctx: IterationContext,
	iterationNum: number,
): AsyncGenerator<RunEvent, PhaseSignal> {
	const iterCheckpoint = await ctx.checkpointMgr.create(ctx.runMgr, iterationNum)

	await ctx.emitEvent({
		type: 'checkpoint_created',
		runId: ctx.runMgr.id,
		checkpointId: iterCheckpoint.id,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const summary = CheckpointManager.buildSummary(ctx.runMgr, iterationNum)
	const iterDecision = await ctx.resumeHandler({
		type: 'iteration_checkpoint',
		runId: ctx.runMgr.id,
		checkpointId: iterCheckpoint.id,
		summary,
	})

	return yield* handleHITLDecision(ctx, iterDecision, iterCheckpoint.id, 'iteration_checkpoint')
}
