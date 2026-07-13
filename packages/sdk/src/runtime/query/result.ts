import { type Span, SpanStatusCode } from '@opentelemetry/api'
import type { PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import type { ActivityStore } from '../../store/activity/memory.js'
import { GENAI, NAMZU } from '../../telemetry/attributes.js'
import type { Run, RunEvent } from '../../types/run/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
import type { EmitEvent } from './events.js'

export interface ResultAssemblerConfig {
	runMgr: RunPersistence
	planManager: PlanManager
	activityStore: ActivityStore
	log: Logger
	emitEvent: EmitEvent
	drainPending: () => Generator<RunEvent>
}

export class ResultAssembler {
	private config: ResultAssemblerConfig

	constructor(config: ResultAssemblerConfig) {
		this.config = config
	}

	async *completeRun(rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, activityStore, log, emitEvent, drainPending } = this.config

		// A suspended run is not a finished run. `query()` already routes the
		// suspension to `suspendRun`, so reaching here with `awaiting_input` means
		// a caller lost the disposition — refuse rather than terminalize. Emitting
		// `run_completed` for a run that is going to run again is the precise bug
		// ses_017 P2 exists to close, and it is worth two lines to make it
		// unreachable from a second direction.
		if (runMgr.status === 'awaiting_input') {
			log.error('completeRun called on a suspended run — refusing to terminalize it', {
				runId: runMgr.id,
			})
			yield* this.suspendRun(rootSpan)
			return
		}

		// A cancelled run is not a completed run, and it used to say it was. The status
		// check below already refused to `markCompleted` it — so its RECORD said
		// `cancelled` — and then the emit right after announced `run_completed` to every
		// listener anyway. Every cancelled run told the wire it had finished: the
		// embedder's `signal.abort()`, the durable `cancelRun`, a reviewer's `abort`, a
		// cancel that lands mid-loop. All of them mark the run cancelled BEFORE the
		// disposition reaches this method, which is why the branch belongs here, at the
		// one place they all funnel through, rather than at each of the six call sites
		// that could each forget it.
		if (runMgr.status === 'cancelled') {
			yield* this.endCancelledRun(rootSpan)
			return
		}

		// **The last place a durable cancel can still be heard.** `abortIfRunCancelled` re-reads
		// the run's status at the three points where the segment can stop before doing something
		// irreversible — the top of an iteration, and immediately before either tool batch. None
		// of them covers the window between the LAST such check and the end of the turn: cancel a
		// run while its final model call is in flight, the model answers `stop`, and the loop
		// breaks `end_turn` having never looked at the disk again. `markCompleted` then stamps
		// `completed` over the `cancelled` the control plane wrote, `finalize()` PERSISTS it —
		// the fence permits it, this segment does hold the lease — and the run the user was told
		// was dead comes to rest completed, with a result, on the wire and on disk.
		//
		// A `cancelled` read here can only be that: admission and `init()` both refuse a run that
		// was ALREADY cancelled, so nothing but a cancel landing DURING this segment can put that
		// word on the disk. And by the time `cancelRun` wrote it, it had already returned
		// `{ status: 'cancelled' }` to whoever asked. The disk wins; the run is cancelled.
		const persisted = await runMgr.getRunStore().readRunMeta()
		if (persisted?.status === 'cancelled') {
			log.info('Run was cancelled while its last iteration was in flight — honouring the cancel', {
				runId: runMgr.id,
			})
			runMgr.markCancelled()
			yield* this.endCancelledRun(rootSpan)
			return
		}

		if (runMgr.status === 'running') {
			runMgr.markCompleted(runMgr.stopReason)
		}

		await emitEvent({
			type: 'run_completed',
			runId: runMgr.id,
			result: runMgr.getRun().result ?? '',
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: runMgr.stopReason ?? 'completed',
			[NAMZU.ITERATION]: runMgr.currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: runMgr.tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: runMgr.tokenUsage.completionTokens,
		})
		rootSpan.setStatus({ code: SpanStatusCode.OK })

		log.info('Query completed', {
			runId: runMgr.id,
			iterations: runMgr.currentIteration,
			stopReason: runMgr.stopReason,
			activityStats: activityStore.enabled ? activityStore.stats() : undefined,
		})
	}

	async *completeSession(rootSpan: Span): AsyncGenerator<RunEvent> {
		yield* this.completeRun(rootSpan)
	}

	/**
	 * Close out a run that was CANCELLED.
	 *
	 * Terminal, like completion — the span ends, the queue drains, the record is already
	 * written ({@link import('../../manager/run/persistence.js').RunPersistence.markCancelled}
	 * ran in whichever phase noticed the cancel) — and it says `run_cancelled`, not
	 * `run_completed`. That one word is the whole method: a client pairing `run_completed`
	 * with "it worked" was being lied to on every cancellation, including the in-process
	 * `signal.abort()` path.
	 *
	 * Not to be confused with the control plane's
	 * {@link import('./decision/resume.js').cancelRun}, which CAUSES a cancellation from
	 * outside the run. This one REPORTS one from inside it, and marks nothing: by the time
	 * a disposition reaches the assembler, the cancel has already been recorded.
	 *
	 * `SpanStatusCode.OK`, deliberately: a cancelled run is not an error. It did what it
	 * was told. `namzu.cancelled` on the span is what distinguishes it from a completion,
	 * and it mirrors what the iteration span already sets.
	 */
	async *endCancelledRun(rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, log, emitEvent, drainPending } = this.config

		await emitEvent({ type: 'run_cancelled', runId: runMgr.id })
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: 'cancelled',
			[NAMZU.CANCELLED]: true,
			[NAMZU.ITERATION]: runMgr.currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: runMgr.tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: runMgr.tokenUsage.completionTokens,
		})
		rootSpan.setStatus({ code: SpanStatusCode.OK })

		log.info('Query cancelled', {
			runId: runMgr.id,
			iterations: runMgr.currentIteration,
			stopReason: runMgr.stopReason,
		})
	}

	/**
	 * Close out a run that parked itself awaiting an external decision.
	 *
	 * The phase that parked it has already called `markSuspended()` and emitted
	 * `run_paused` — that is the event a client learns the pause from. This method
	 * exists to end the *span* and drain the queue without doing any of the things
	 * the completion path does: it marks nothing, resolves nothing, and emits no
	 * terminal event. The generator returns; the run stays `awaiting_input` on disk.
	 */
	async *suspendRun(rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, log, drainPending } = this.config

		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: 'awaiting_input',
			[NAMZU.ITERATION]: runMgr.currentIteration,
			[GENAI.USAGE_INPUT_TOKENS]: runMgr.tokenUsage.promptTokens,
			[GENAI.USAGE_OUTPUT_TOKENS]: runMgr.tokenUsage.completionTokens,
		})
		rootSpan.setStatus({ code: SpanStatusCode.OK })

		log.info('Query suspended — awaiting an external decision', {
			runId: runMgr.id,
			iterations: runMgr.currentIteration,
			stopReason: runMgr.stopReason,
		})
	}

	/**
	 * Walk away from a run this segment no longer owns.
	 *
	 * **It emits nothing, marks nothing, and persists nothing** — and each of those is a
	 * thing {@link handleError} would have done. A superseded segment driven through the
	 * failure path emits a terminal `run_failed` to every listener (the API's SSE feed, the
	 * event bridges, the CLI's run view) and appends it to `transcript.jsonl`, which is
	 * append-only and deliberately unfenced — for a run that another segment is at that
	 * moment driving to completion. The persisted transcript then contains a `run_failed`
	 * for a run that finished, and every consumer of the stream saw a live run die.
	 *
	 * The fence stops a segment that lost its lease from writing the run's RECORD. Nothing
	 * stopped it from announcing the run's death. This does.
	 *
	 * The span still ends and the loss is still logged: this segment really did stop, and
	 * the operator is entitled to know why. It is the RUN's story that is not ours to tell.
	 */
	async abandonSegment(err: unknown, rootSpan: Span): Promise<void> {
		const { runMgr, log } = this.config
		const message = toErrorMessage(err)

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: 'disowned',
			[NAMZU.ITERATION]: runMgr.currentIteration,
		})
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message })
		rootSpan.recordException(err instanceof Error ? err : new Error(message))

		log.warn(
			'This segment no longer owns the run it was driving — exiting without touching its record. Whatever owns it now is the only thing entitled to say how it ends.',
			{ runId: runMgr.id, reason: message },
		)
	}

	async *handleError(err: unknown, rootSpan: Span): AsyncGenerator<RunEvent> {
		const { runMgr, planManager, log, emitEvent, drainPending } = this.config
		const errorMessage = toErrorMessage(err)
		runMgr.markFailed(errorMessage)

		if (planManager.isActive) {
			planManager.failPlan(errorMessage)
		}

		await emitEvent({
			type: 'run_failed',
			runId: runMgr.id,
			error: errorMessage,
		})
		yield* drainPending()

		rootSpan.setAttributes({
			[NAMZU.RUN_STATUS]: 'error',
			[NAMZU.ITERATION]: runMgr.currentIteration,
		})
		rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage })
		rootSpan.recordException(err instanceof Error ? err : new Error(errorMessage))

		log.error('Query failed', {
			runId: runMgr.id,
			error: errorMessage,
		})
	}

	async finalize(): Promise<Run> {
		await this.config.runMgr.persist()
		return this.config.runMgr.getRun()
	}
}
