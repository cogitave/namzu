import { GENAI, NAMZU } from '../../../../telemetry/attributes.js'
import { NamzuError } from '../../../../types/errors/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import type { ToolCallOutcome } from '../../executor.js'
import type { IterationContext, PhaseSignal } from './context.js'

/**
 * A tool asked for a person: stop before the next model call.
 *
 * Runs after the batch settled, so every result — the one that asked and
 * its siblings — is already in the transcript and queued for the session
 * log. The checkpoint written here is taken from that state, which is what
 * lets a resume continue exactly as it does after a provider pause: the
 * next step is a model call that sees the results.
 *
 * The first request in the batch speaks for it. Two tools that both need a
 * person need the same thing from the operator — to come and look — and
 * one pause answers both.
 *
 * In a delegated child the turn fails with the reason instead. Nobody
 * resumes a child's turn: its parent is waiting on a result, and a failed
 * child with the reason in it is a result the parent's model can act on.
 */
export async function* runHandoffPause(
	ctx: IterationContext,
	iterationNum: number,
	results: readonly ToolCallOutcome[],
): AsyncGenerator<SessionEvent, PhaseSignal> {
	const requested = results.find((result) => result.handoff !== undefined)
	const handoff = requested?.handoff
	if (!requested || !handoff) return 'continue'

	if (ctx.delegated) {
		ctx.log.info('A tool in a delegated turn needs a person; the turn fails', {
			[NAMZU.TURN_ID]: ctx.recorder.turnId,
			[NAMZU.ITERATION]: iterationNum,
			[GENAI.TOOL_NAME]: requested.toolName,
		})
		throw new NamzuError({
			code: 'tool_error',
			message: `${requested.toolName} needs a person: ${handoff.reason}`,
			details: { toolName: requested.toolName, handoff },
			retryable: false,
		})
	}

	const checkpoint = await ctx.checkpointMgr.create(ctx.recorder, iterationNum)
	await ctx.emitEvent({
		type: 'checkpoint_created',
		turnId: ctx.recorder.turnId,
		checkpointId: checkpoint.id,
		iteration: iterationNum,
	})
	yield* ctx.drainPending()

	await ctx.emitEvent({
		type: 'turn_paused',
		budget: ctx.recorder.budget?.summary(),
		turnId: ctx.recorder.turnId,
		checkpointId: checkpoint.id,
		reason: handoff.reason,
		handoff,
	})
	yield* ctx.drainPending()
	ctx.recorder.setStopReason('paused')
	ctx.log.info('Turn paused for a person', {
		[NAMZU.TURN_ID]: ctx.recorder.turnId,
		[NAMZU.ITERATION]: iterationNum,
		[GENAI.TOOL_NAME]: requested.toolName,
		'namzu.checkpoint.id': checkpoint.id,
		'namzu.runtime.reason': handoff.reason,
	})
	return 'stop'
}
