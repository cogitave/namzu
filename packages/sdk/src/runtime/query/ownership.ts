import type { RunPersistence } from '../../manager/run/persistence.js'
import { RunLeaseLostError } from '../../types/run/lease.js'
import type { Logger } from '../../utils/logger.js'
import { RunNotResumableError } from './decision/errors.js'

/**
 * Does this segment still have standing to speak for the run?
 *
 * Two ways to lose it, and they are the same fact from two directions:
 *
 *   - {@link RunLeaseLostError} — the run was taken over, the lease expired under us, or
 *     the consumer walked away. Somebody else owns this run now, or nobody does.
 *   - {@link RunNotResumableError} — the run reached a terminal state that this segment
 *     may not continue. Raised in admission, and again by `RunPersistence.init()` for the
 *     cancel that lands *between* admission's read and the first write.
 *
 * **A segment without standing exits SILENTLY.** It does not emit `run_failed`, it does not
 * append a terminal event to the run's transcript, and it does not persist. Those are the
 * acts of a run's owner, and a superseded segment is not one: its `run_failed` goes out on
 * the SSE feed, the event bridges and the CLI's run view for a run that another segment is
 * at that moment driving to completion, and it lands in the shared `transcript.jsonl` —
 * which is deliberately unfenced, so nothing else stops it. The fence refuses the dead
 * segment's *record* writes; only this refuses its *claims*.
 */
export function isSegmentDisowned(err: unknown): err is RunLeaseLostError | RunNotResumableError {
	return err instanceof RunLeaseLostError || err instanceof RunNotResumableError
}

/** The seams a durable-cancellation check needs. Both the loop and the dispatcher have them. */
export interface CancellableSegment {
	readonly runMgr: RunPersistence
	readonly abortController: AbortController
	readonly log: Logger
}

/**
 * Has the run been cancelled out from under this segment?
 *
 * **The lease does not close this window, and it never can.** `cancelRun` is the control
 * plane: it holds no lease and is deliberately unfenced, because a cancel that could not
 * touch a run somebody is driving would be useless — a parked run has no live process to
 * signal, and a running one has no in-band channel to reach. So `run.json` can flip to
 * `cancelled` at ANY moment after admission read it, and the admission docstring's claim
 * that "under the lease, the status this reads is the status that holds for as long as this
 * segment holds it" was simply false.
 *
 * A single check at admission is therefore not a guard, it is a sample. The run's status has
 * to be re-read at the points where the segment can still stop *without having already done
 * the irreversible thing*, and there are exactly three of them:
 *
 *   1. **The top of each iteration**, before the model call. Cheap, and it is what makes a
 *      durable cancel actually reach a RUNNING run at all — without it, cancelling a run
 *      that is mid-loop reaches nobody and the loop keeps burning provider calls until it
 *      finishes on its own.
 *   2. **Immediately before a resumed decision's approved batch is dispatched.** This is the
 *      one that matters: the user cancelled, was told the run was dead, and the deploy tool
 *      they cancelled was about to run anyway.
 *   3. **Immediately before the loop's own tool batch is executed** — the same instant, one
 *      door along. A tool's side effect is the thing that cannot be taken back, so the last
 *      possible check goes as close to it as it can get.
 *
 * What it cannot do is stop a batch that is ALREADY in flight; the cancel that lands one
 * millisecond after the executor was handed the batch has missed it, and no amount of
 * checking changes that. The window is now a `readFile` wide instead of a whole iteration
 * wide, and the docs say so honestly rather than claiming the lease closes it.
 *
 * Reported as a CANCELLATION, not a failure: it is routed through the segment's own
 * `AbortController`, which is the machinery an in-process cancel has always used, so the
 * run heals its history, marks itself `cancelled` and persists that — agreeing with what
 * the control plane already wrote instead of racing it.
 */
export async function abortIfRunCancelled(ctx: CancellableSegment, at: string): Promise<boolean> {
	if (ctx.abortController.signal.aborted) return false

	const persisted = await ctx.runMgr.getRunStore().readRunMeta()
	if (persisted?.status !== 'cancelled') return false

	ctx.log.info('Run was cancelled out of process — stopping before it does anything else', {
		runId: ctx.runMgr.id,
		at,
	})
	ctx.abortController.abort(new RunCancelledElsewhereError(ctx.runMgr.id, at))
	return true
}

/**
 * The run was cancelled by somebody who is not this segment.
 *
 * The abort reason, so that a cancellation discovered on disk is distinguishable from a
 * lease loss (which exits silently) and from an embedder's own `signal.abort()` (which is
 * the same thing and is treated identically). Nothing branches on the class; it exists so
 * that a log line and an aborted-signal reason say WHY.
 */
export class RunCancelledElsewhereError extends Error {
	readonly runId: string
	readonly at: string

	constructor(runId: string, at: string) {
		super(`Run ${runId} was cancelled while this segment was driving it (noticed ${at})`)
		this.name = 'RunCancelledElsewhereError'
		this.runId = runId
		this.at = at
	}
}
