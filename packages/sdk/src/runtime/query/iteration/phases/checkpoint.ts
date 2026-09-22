import { NAMZU } from '../../../../constants/telemetry/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import { toErrorMessage } from '../../../../utils/error.js'
import { CheckpointManager } from '../../checkpoint.js'
import {
	type IterationContext,
	type PhaseSignal,
	awaitDecisionDurably,
	handleHITLDecision,
} from './context.js'

/**
 * Cadence gate for the per-iteration checkpoint (`turnConfig.checkpointEvery`,
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
): AsyncGenerator<SessionEvent, PhaseSignal> {
	if (!isOnCheckpointCadence(iterationNum, ctx.turnConfig.checkpointEvery)) {
		return 'continue'
	}

	const iterCheckpoint = await ctx.checkpointMgr.create(ctx.recorder, iterationNum)

	// Growth control: keep only the newest N checkpoints when the host asked
	// for pruning. Default undefined ⇒ never prune (today's behavior).
	//
	// A failed prune is logged, not thrown. The checkpoint this iteration
	// needs was written above; failing to delete OLD ones costs disk, and
	// ending a live turn over disk that can be reclaimed at its next
	// iteration trades the user's work for housekeeping.
	const pruneKeepLast = ctx.turnConfig.pruneKeepLast
	if (pruneKeepLast !== undefined && pruneKeepLast >= 1) {
		try {
			await ctx.checkpointMgr.prune(Math.floor(pruneKeepLast))
		} catch (err) {
			ctx.log.warn('Checkpoint retention failed; older checkpoints are kept for now', {
				[NAMZU.TURN_ID]: ctx.recorder.turnId,
				[NAMZU.ITERATION]: iterationNum,
				'exception.message': toErrorMessage(err),
			})
		}
	}

	await ctx.emitEvent({
		type: 'checkpoint_created',
		turnId: ctx.recorder.turnId,
		checkpointId: iterCheckpoint.id,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	const summary = CheckpointManager.buildSummary(ctx.recorder, iterationNum)
	const iterDecision = await awaitDecisionDurably(ctx, iterCheckpoint, {
		type: 'iteration_checkpoint',
		sessionId: ctx.recorder.sessionId,
		turnId: ctx.recorder.turnId,
		checkpointId: iterCheckpoint.id,
		summary,
	})

	return yield* handleHITLDecision(ctx, iterDecision, iterCheckpoint.id, 'iteration_checkpoint')
}
