import type { Span } from '@opentelemetry/api'
import type { WorkingStateManager } from '../../compaction/manager.js'
import { NAMZU } from '../../constants/telemetry/index.js'
import type { EmergencySaveManager } from '../../manager/run/emergency.js'
import { recordRunDuration } from '../../telemetry/metrics.js'
import type { RunEvent } from '../../types/run/index.js'
import { type PromoteMemory, memoryCandidateFor } from '../../types/run/memory-promotion.js'
import type { Sandbox } from '../../types/sandbox/index.js'
import { errorAttributes } from '../../utils/log/exception.js'
import type { AwaitedJobs } from '../jobs/awaited-jobs.js'
import type { BackgroundJobRegistry } from '../jobs/registry.js'
import type { RunContext } from './context.js'
import type { EventTranslator } from './events.js'
import type { QuestionParkBinding } from './question-park.js'
import { teardownSandbox } from './sandbox-lifecycle.js'

/**
 * Everything a run borrows, handed back when it ends.
 *
 * A run attaches to process-wide things it does not own — crash handlers, a
 * shared background-job registry, a question channel a tool outlived, a task
 * store's listener, a sandbox — and every one of them has to be released on
 * the way out, including the exits a `try` never reaches. So this is the body
 * of `query()`'s `finally`: the keyword stays where it is, which is what makes
 * abandonment run this just as settlement does.
 *
 * The order is the contract, and the awaits are in it: detach the emergency
 * handlers, unsubscribe from job exits, close the wait-intent recorder, kill
 * only this run's jobs, unbind the question channel, promote what the run
 * learned, tear the sandbox down, unsubscribe from the task store, record the
 * duration under the status the run actually settled with, and end the root
 * span last.
 */
export interface RunResources {
	readonly ctx: RunContext
	readonly eventTranslator: EventTranslator
	readonly emergencyManager: EmergencySaveManager | undefined
	readonly unsubscribeJobExits: (() => void) | undefined
	readonly unsubscribeTaskStore: (() => void) | undefined
	readonly awaitedJobs: AwaitedJobs | undefined
	/** Jobs a host bound to its session are the host's to stop, not this run's. */
	readonly backgroundJobs: BackgroundJobRegistry | undefined
	readonly backgroundJobOwner: string | undefined
	readonly questionParks: QuestionParkBinding
	readonly workingStateManager: WorkingStateManager | undefined
	readonly promoteMemory: PromoteMemory | undefined
	readonly sandbox: Sandbox | undefined
	readonly sandboxTeardownTimeoutMs: number
	readonly runStartedAt: number
	readonly rootSpan: Span
}

/**
 * Release them, in that order.
 *
 * A generator rather than a plain async function because the sandbox teardown
 * reports `sandbox_destroyed`, and that event has to reach the host at the
 * position it always did — `yield*` from the caller's `finally` keeps it
 * exactly there.
 */
export async function* releaseRunResources(
	resources: RunResources,
): AsyncGenerator<RunEvent, void> {
	const {
		ctx,
		eventTranslator,
		emergencyManager,
		unsubscribeJobExits,
		unsubscribeTaskStore,
		awaitedJobs,
		backgroundJobs,
		backgroundJobOwner,
		questionParks,
		workingStateManager,
		promoteMemory,
		sandbox,
		sandboxTeardownTimeoutMs,
		runStartedAt,
		rootSpan,
	} = resources

	// Release the process's termination path as soon as this run is
	// done with it. Leaving the handlers installed would keep a
	// WeakRef'd, settled run as the crash target for the rest of the
	// process's life.
	emergencyManager?.detach()

	// A background job outlives the tool call that started it — that
	// is what it is for — so nothing but this stops it outliving the
	// RUN. Scoped to this run's id: a shared registry serving several
	// runs must not have one of them tear down another's work.
	//
	// Awaited, and its failure swallowed. A job that would not die is
	// worth a log line, and is not worth retracting a run's answer.
	unsubscribeJobExits?.()
	// The wait-intent recorder listens on the same shared registry and
	// leaks the same way if it is left attached.
	awaitedJobs?.close()
	// Only jobs bound to this run. Jobs a host bound to its session are
	// the host's to stop, when the session ends.
	if (backgroundJobs && (backgroundJobOwner ?? ctx.runId) === ctx.runId) {
		try {
			const stopped = await backgroundJobs.killOwner(ctx.runId)
			if (stopped.length > 0) {
				ctx.log.info('Background jobs stopped with the run', {
					[NAMZU.RUN_ID]: ctx.runId,
					'namzu.jobs.stopped': stopped.length,
				})
			}
		} catch (jobErr) {
			ctx.log.error('A background job did not stop cleanly', {
				[NAMZU.RUN_ID]: ctx.runId,
				...errorAttributes(jobErr),
			})
		}
	}

	// Same reasoning for the question channel: the tools outlive the
	// run that bound them, so leaving it attached would have a later
	// run's question written into this run's checkpoint store.
	questionParks.unbind()

	// Offer what the run learned to whoever decides what is worth
	// keeping. In `finally` and awaited: a run that failed still
	// discovered things, and a fire-and-forget write would race the
	// process exiting on a one-shot CLI run. A throw here is
	// swallowed — a memory that failed to form must not retract an
	// answer that was already produced.
	const candidate = memoryCandidateFor(ctx.runId, workingStateManager)
	if (promoteMemory && candidate) {
		try {
			await promoteMemory(candidate)
		} catch (promoteErr) {
			ctx.log.error('Memory promotion threw — the run is unaffected', {
				[NAMZU.RUN_ID]: ctx.runId,
				'exception.message': promoteErr instanceof Error ? promoteErr.message : String(promoteErr),
			})
		}
	}

	// --- Sandbox lifecycle: destroy after run ---
	if (sandbox) {
		const sandboxId = sandbox.id
		const teardown = await teardownSandbox(sandbox, sandboxTeardownTimeoutMs)
		if (teardown.kind === 'destroyed') {
			await eventTranslator.emitEvent({
				type: 'sandbox_destroyed',
				runId: ctx.runId,
				sandboxId,
			})
			yield* eventTranslator.drainPending()
			ctx.log.info('Sandbox destroyed', { 'namzu.sandbox.id': sandboxId })
		} else {
			ctx.log.error('Sandbox destroy failed', {
				'namzu.sandbox.id': sandboxId,
				...errorAttributes(teardown.error),
			})
		}
	}

	unsubscribeTaskStore?.()
	// Keyed by HOW it settled, not just that it did: a run that was
	// cancelled and a run that hit its budget have very different
	// duration distributions, and averaging them together describes
	// neither.
	recordRunDuration(ctx.runMgr.getRun().status ?? 'unknown', Date.now() - runStartedAt)
	rootSpan.end()
}
