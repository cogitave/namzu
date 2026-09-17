import type { RunPersistence } from '../../manager/run/persistence.js'
import { GENAI, NAMZU, agentRunSpanName, parentContext } from '../../telemetry/attributes.js'
import { getTracer } from '../../telemetry/runtime-accessors.js'
import { createSystemMessage } from '../../types/message/index.js'
import type { FencingToken } from '../../types/run/checkpoint-store.js'
import type { RunEventCursor, RunEventReplay } from '../../types/run/event-cursor.js'
import { resolveRunEventReplay } from '../../types/run/event-cursor.js'
import type { Run, RunEvent } from '../../types/run/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { QueryParams } from './index.js'
import type { PreparedRun } from './prepare-run.js'
import { ResultAssembler } from './result.js'

/**
 * The run that was cancelled before it started.
 *
 * Attachment materialization happens before `RunContext` exists, and a
 * cancellation observed there still belongs to a run: it must be recorded,
 * classified and reported like any other, without any of the authority-bearing
 * work — prompt contributions, host callbacks, tools, plugins, sandbox,
 * guardrails, advisors, providers — that a run which is allowed to proceed
 * would do next.
 *
 * An `async function*` rather than a plain async function, and reached with
 * `yield*`, because this path still emits and drains: the events it produces
 * must occupy exactly the positions in the stream they occupied when the code
 * lived inline, and only delegation preserves every yield point.
 */
export async function* settlePreStartCancellation(
	params: QueryParams,
	prepared: PreparedRun,
): AsyncGenerator<RunEvent, Run> {
	const {
		ctx,
		runConfig,
		eventTranslator,
		executeUserInterruptHooks,
		selectedResumeState,
		queuedForThisRun,
		initialMessages,
	} = prepared

	// Attachment materialization happens before RunContext exists. Once it
	// observes cancellation, do only the work required to leave an honest
	// durable run: initialize the record, retain the unresolved references,
	// and settle through the ordinary cancellation classifier. Prompt
	// contributions/cache, host callbacks, tools, plugins, sandbox, guardrails,
	// advisors, and providers are all authority-bearing work and stay out.
	// The dedicated root interrupt notification is the sole plugin exception:
	// it runs after cancellation under its own deadline and cannot regain model
	// or tool authority.
	if (params.resumeFromCheckpoint && !selectedResumeState) {
		// The canonical resume surface hands query the checkpoint state it
		// already selected. A raw resume query has no such snapshot; after
		// cancellation, reading the store again could hang without a signal,
		// while persisting without it would erase the existing transcript.
		// Refuse before binding/persisting rather than choose either failure.
		ctx.abortController.signal.throwIfAborted()
	}

	const cancelledPrompt = params.systemPrompt ?? ''
	const cancelledAssembler = new ResultAssembler({
		runMgr: ctx.runMgr,
		planManager: ctx.planManager,
		activityStore: ctx.activityStore,
		log: ctx.log,
		emitEvent: eventTranslator.emitEvent,
		drainPending: () => eventTranslator.drainPending(),
		signal: ctx.abortController.signal,
	})
	const rootSpan = getTracer().startSpan(
		agentRunSpanName(params.agentName),
		{},
		parentContext(params.parentSpan ?? selectedResumeState?.traceContext),
	)
	rootSpan.setAttributes({
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		[GENAI.AGENT_NAME]: params.agentName,
		[GENAI.AGENT_ID]: params.agentId,
		[GENAI.REQUEST_MODEL]: runConfig.model,
		[GENAI.SYSTEM]: params.provider.id,
	})

	try {
		await ctx.runMgr.init()
		if (selectedResumeState) {
			ctx.runMgr.restoreUsage(
				selectedResumeState.tokenUsage,
				selectedResumeState.costInfo,
				selectedResumeState.currentIteration,
			)
			for (const message of selectedResumeState.messages) ctx.runMgr.pushMessage(message)
			for (const queued of queuedForThisRun) ctx.runMgr.pushMessage(queued)
		} else if (params.continuationMode) {
			for (const message of initialMessages) ctx.runMgr.pushMessage(message)
		} else {
			ctx.runMgr.pushMessage(createSystemMessage(cancelledPrompt, 'cache'))
			for (const message of initialMessages) ctx.runMgr.pushMessage(message)
		}
		if (params.eventCursor) {
			yield* catchUpFromCursor(
				ctx.runMgr,
				params.eventCursor,
				params.onEventReplay,
				params.claimFence,
				(error) => {
					ctx.log.warn('Replay observer failed after attachment cancellation', {
						'exception.message': toErrorMessage(error),
					})
				},
			)
		}
		if (selectedResumeState) {
			await eventTranslator.emitEvent({
				type: 'run_resuming',
				runId: ctx.runId,
				fromCheckpointId: selectedResumeState.checkpointId,
			})
			yield* eventTranslator.drainPending()
		}
		ctx.runMgr.markRunning()
		await eventTranslator.emitEvent({
			type: 'run_started',
			runId: ctx.runId,
			systemPrompt: cancelledPrompt,
		})
		yield* eventTranslator.drainPending()
		ctx.abortController.signal.throwIfAborted()
	} catch (error) {
		// Attachment resolution has already observed the caller's abort. A
		// reconnect callback can still throw while replay is being reported,
		// but it cannot replace that terminal cause or turn a cancelled run
		// into an unpersisted rejection.
		const terminalError = ctx.abortController.signal.aborted
			? ctx.abortController.signal.reason
			: error
		await executeUserInterruptHooks(terminalError)
		yield* eventTranslator.drainPending()
		yield* cancelledAssembler.handleError(terminalError, rootSpan)
	} finally {
		rootSpan.end()
	}

	return await cancelledAssembler.finalize()
}

/**
 * Hand a returning consumer what it missed, or tell it why it cannot have it.
 *
 * Yields NOTHING on a refusal. A partial catch-up is the failure this exists to
 * prevent: a consumer that receives some of the gap folds it into its state and
 * cannot tell the state is wrong, where one that receives an explicit
 * `unavailable` re-derives from the transcript and is right. The run continues
 * either way — a stale cursor belongs to the client, and must not be able to
 * stop the work.
 */
export async function* catchUpFromCursor(
	runMgr: RunPersistence,
	cursor: RunEventCursor,
	onEventReplay: ((replay: RunEventReplay) => void) | undefined,
	generation: FencingToken | undefined,
	onReplayObserverError: (error: unknown) => void,
): AsyncGenerator<RunEvent, void> {
	const missed = await runMgr.getRunStore().readEvents({ sinceSeq: cursor.sinceSeq })
	const replay = resolveRunEventReplay(
		cursor,
		{
			lastSeq: runMgr.lastEventSeq,
			...(generation !== undefined ? { generation } : {}),
		},
		missed,
	)

	if (onEventReplay) {
		try {
			// A callback typed `void` may still be implemented with `async` in
			// TypeScript. Observe that runtime Promise so a late rejection cannot
			// become process-wide, but never await host code here: replay delivery
			// and an already-cancelled run must not inherit observer liveness.
			const settlement = onEventReplay(replay)
			void Promise.resolve(settlement).catch(onReplayObserverError)
		} catch (error) {
			onReplayObserverError(error)
		}
	}

	if (replay.status !== 'replayed') return
	for (const event of replay.events) yield event
}
