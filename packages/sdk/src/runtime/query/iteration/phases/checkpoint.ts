import type { RunEvent } from '../../../../types/run/index.js'
import { CheckpointManager } from '../../checkpoint.js'
import {
	type IterationContext,
	type PhaseSignal,
	awaitDecisionOrAbort,
	handleHITLDecision,
} from './context.js'

/**
 * Cadence gate for the per-iteration checkpoint (`runConfig.checkpointEvery`,
 * default 1 = every iteration). Off-cadence iterations skip the whole phase —
 * no checkpoint, no `checkpoint_created` event, and no HITL
 * `iteration_checkpoint` park (there is no checkpoint id to park on).
 * Iterations 1, 1+N, 1+2N, … checkpoint, so the first tool iteration is
 * always covered (a crash before the first cadence hit would otherwise leave
 * nothing to resume from).
 */
function isOnCheckpointCadence(iterationNum: number, checkpointEvery: number | undefined): boolean {
	const every = Math.max(1, Math.floor(checkpointEvery ?? 1))
	return (iterationNum - 1) % every === 0
}

export async function* runIterationCheckpoint(
	ctx: IterationContext,
	iterationNum: number,
): AsyncGenerator<RunEvent, PhaseSignal> {
	if (!isOnCheckpointCadence(iterationNum, ctx.runConfig.checkpointEvery)) {
		return 'continue'
	}

	const iterCheckpoint = await ctx.checkpointMgr.create(ctx.runMgr, iterationNum)

	// Growth control: keep only the newest N checkpoints when the host asked
	// for pruning. Default undefined ⇒ never prune (today's behavior).
	const pruneKeepLast = ctx.runConfig.pruneKeepLast
	if (pruneKeepLast !== undefined && pruneKeepLast >= 1) {
		await ctx.checkpointMgr.prune(Math.floor(pruneKeepLast))
	}

	await ctx.emitEvent({
		type: 'checkpoint_created',
		runId: ctx.runMgr.id,
		checkpointId: iterCheckpoint.id,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const summary = CheckpointManager.buildSummary(ctx.runMgr, iterationNum)
	const iterDecision = await awaitDecisionOrAbort(ctx, {
		type: 'iteration_checkpoint',
		runId: ctx.runMgr.id,
		checkpointId: iterCheckpoint.id,
		summary,
	})

	return yield* handleHITLDecision(ctx, iterDecision, iterCheckpoint.id, 'iteration_checkpoint')
}
