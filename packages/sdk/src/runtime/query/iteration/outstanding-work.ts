import { NAMZU } from '../../../constants/telemetry/index.js'
import { formatCompletionNotification } from '../../../scheduler/completion-inbox.js'
import { DELEGATION_TIMEOUT_MS } from '../../../tools/coordinator/index.js'
import { createRuntimeContextMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { readPositiveIntEnv } from '../../../utils/env.js'
import { formatJobNote } from '../steering.js'
import type { IterationContext } from './phases/index.js'

/**
 * The run's settle points: holding open for work that has not finished, and
 * delivering what arrived.
 *
 * Two kinds of work qualify — a delegated task the `CompletionInbox` is still
 * expecting, and a background job the model told `wait_for_job` it is waiting
 * on — and both are raced together, because a run has one settle point and one
 * grace period to spend at it.
 *
 * Everything here reads the iteration context rather than capturing it, and
 * the one thing it cannot read off that context — how this run drains its
 * inbound queue — arrives as an explicit `deliverInbound` input, because the
 * recording of operator intent that goes with it belongs to the orchestrator.
 * `holdForOutstandingWork` is a generator and is reached with `yield*`: its
 * one event must land at the position it landed at when it lived on the class.
 */

/**
 * The share of a run's REMAINING time a settle-hold may take.
 *
 * The rule is borrowed from `AGENT_MANAGER_DEFAULTS.maxBudgetFraction`, which
 * gives a spawned child at most half of what its parent has left: one
 * sub-activity may take a share of the remainder, never the remainder. The
 * value is written out here rather than imported, because that field is a
 * host-tunable knob about TOKEN allocation and coupling the two would let a
 * host lowering one silently change the other.
 *
 * Half, specifically, because the hold is not the last thing the run does.
 * Its whole purpose is to put a worker's result where the model can read it,
 * and reading it costs a turn. A hold that spent everything remaining would
 * deliver a notification into a run with no turn left to act on it — the same
 * "the result exists and the model is never told" failure this mechanism was
 * built to close, wearing a different costume.
 */
const SETTLE_GRACE_FRACTION = 0.5

/**
 * How long a finishing run waits for a background worker it launched.
 *
 * Derived from the run rather than fixed, because a constant is wrong in both
 * directions at once. The 120 seconds this replaces held a run configured for
 * a twenty-second timeout open for 120,267 ms — six times its own budget, and
 * unreachable by the guard, which only checks between iterations — while on an
 * hour-long run it abandoned workers measured at 4m21s, 5m58s and 8m04s, all
 * of them well inside the hour the delegation tools themselves declare.
 *
 * **Bounded by construction, and against the right boundary.** The input is
 * time-to-FINALIZE, not time-to-deadline (see
 * `GuardCoordinator.remainingBeforeFinalizeMs`). Measuring to the deadline was
 * the first attempt and it was wrong in a way that looked safe: a hold cannot
 * outlive the deadline either way, but half of the time-to-deadline started
 * just under the warning threshold ends at 95% of the budget — so the slice
 * that exists for the run to produce a closing answer is half spent waiting
 * for the result that answer was supposed to use. Against the finalize point
 * the hold cannot reach the reserve at all, which is what makes the guard's
 * inability to interrupt a hold a non-issue rather than a smaller issue.
 *
 * **The floor of zero is a decision, not a clamp artefact.** A run with no
 * time left before it must start finishing has no turn in which to read a
 * notification, so waiting could only delay a stop that is already due.
 * Nothing is lost by it: `CompletionInbox.waitForArrival` returns before it
 * looks at its timer when a completion is already in hand, so a zero grace
 * still delivers everything that has arrived. No minimum is invented on top,
 * because zero is exactly what a run past the threshold should wait — and
 * reading the remainder at hold time rather than trusting `forceFinalize`,
 * which is sampled at the top of the iteration, is what makes a long iteration
 * that crossed the line in between compute it.
 *
 * **The ceiling is the longest anything in this subsystem waits for a
 * delegated worker.** It binds only for a host whose run timeout exceeds
 * roughly two and a quarter hours; below that the fraction is smaller.
 */
export function settleGraceMs(remainingBeforeFinalizeMs: number): number {
	return Math.min(
		Math.floor(remainingBeforeFinalizeMs * SETTLE_GRACE_FRACTION),
		DELEGATION_TIMEOUT_MS,
	)
}

/**
 * The ceiling on the job half of that grace, in milliseconds.
 *
 * `DELEGATION_TIMEOUT_MS` is the wrong ceiling for a shell job, and the gap
 * only opens where it matters most: a run with no `timeoutMs` — the CLI's
 * shipping default, `No run deadline by default` — has infinite time before
 * it must start finishing, so `settleGraceMs` returns the ceiling flat. For a
 * delegated task that is sound, because the hour is the longest the task
 * itself may live: the hold cannot outlast the work. A background job has no
 * such bound. `tail -f`, a watcher and a dev server all outlive any hold, so
 * the same arithmetic parks an interactive session for an hour on a job that
 * was never going to exit.
 *
 * So the job leg gets its own bound, and it is sized to what the wait buys
 * rather than to how long a job may live: a turn in which to use the exit.
 * A model that already waited its `wait_for_job` bound out and saw nothing is
 * not usually two minutes from an exit, and the run ending is not the news
 * being lost — with no run in flight the session announces the exit itself
 * (`docs/cli/background-jobs.md`, *Learning that it ended*), which is the
 * cheaper of the two places to hear it.
 */
const DEFAULT_JOB_HOLD_MAX_MS = 2 * 60 * 1000

/**
 * The same share of the run, under {@link DEFAULT_JOB_HOLD_MAX_MS}.
 *
 * `NAMZU_JOB_HOLD_MAX_MS` overrides the ceiling for a host that wants a
 * longer or shorter park, the way `NAMZU_JOB_WAIT_TIMEOUT_MS` overrides
 * `wait_for_job`'s own bound — and it is the same parse, so a value that is
 * not a positive whole number of milliseconds leaves the default standing
 * rather than holding a run for `NaN`. Called here rather than at module
 * load, because a host that sets it after import is not ignored.
 */
export function awaitedJobGraceMs(remainingBeforeFinalizeMs: number): number {
	const ceiling = readPositiveIntEnv('NAMZU_JOB_HOLD_MAX_MS', DEFAULT_JOB_HOLD_MAX_MS)
	return Math.min(settleGraceMs(remainingBeforeFinalizeMs), ceiling)
}

/**
 * Hold the run open for work that has not finished, and deliver it.
 *
 * Returns whether a completion, a job exit or an operator message entered
 * the transcript — the caller continues on `true`, so the model gets a turn
 * to respond. That turn is the entire justification for waiting, which
 * is why only the exits that can still take one call this.
 *
 * Two kinds of work qualify and they are raced together, because a run has
 * one settle point and one grace period to spend at it:
 *
 *  - a delegated task the `CompletionInbox` is still expecting;
 *  - a background job the model told `wait_for_job` it is waiting on.
 *
 * The job half is deliberately narrow. Intent comes from the wait and from
 * nothing else — a dev server the model started and never waited on is
 * running because somebody wanted it running, and a hold for it would add
 * the grace period to the end of every turn for the rest of the session.
 *
 * Each leg is opened only when it has something pending: both
 * `waitForArrival` implementations resolve immediately when their own side
 * is idle, so racing an idle one would end the hold before it began.
 *
 * Bounded by `settleGraceMs` and by `maxIterations`, so work that never
 * finishes cannot keep the run open. On a run with a deadline the grace is
 * a share of what is LEFT of it rather than a fresh allowance, so a
 * `wait_for_job` call that already spent minutes has shortened this hold
 * by the same minutes. On a run without one — the CLI's default — there is
 * no remainder to take a share of, and the job leg's own ceiling
 * (`awaitedJobGraceMs`) is what keeps a timed-out wait from being followed
 * by an hour of silence.
 */
export async function* holdForOutstandingWork(
	ctx: IterationContext,
	iterationNum: number,
	hasToolCalls: boolean,
	deliverInbound: () => number,
): AsyncGenerator<RunEvent, boolean> {
	const inbox = ctx.completionInbox?.hasPendingWork ? ctx.completionInbox : undefined
	const jobs = ctx.awaitedJobs?.hasPendingWork ? ctx.awaitedJobs : undefined
	if (!inbox && !jobs) return false

	// Read HERE rather than from `forceFinalize`, which was sampled at the
	// top of the iteration: one that has since crossed the finalize point
	// must not open a wait against a reserve it has already entered.
	const remainingMs = ctx.guard.remainingBeforeFinalizeMs()
	// One deadline for the race, and it is the LONGEST ceiling any pending
	// leg justifies. A leg resolving on its own timer ends the whole race,
	// so handing the job leg its shorter ceiling while a task was also
	// outstanding would cut the task's hold down to the job's — a run
	// walking away from a worker it had time for, because a job happened
	// to be running. A job therefore never shortens a wait, and it never
	// lengthens one either: where a task is outstanding too, that is how
	// long this run was waiting anyway.
	const graceMs = inbox ? settleGraceMs(remainingMs) : awaitedJobGraceMs(remainingMs)
	ctx.log.info('Holding the run open for outstanding work', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		[NAMZU.ITERATION]: iterationNum,
		'namzu.runtime.grace_ms': graceMs,
		'namzu.runtime.awaited_jobs': jobs?.outstandingJobIds ?? [],
	})
	// User input releases this wait without cancelling any child. Both waits
	// share a disposable signal so the losing arrival listener cannot leak.
	const waiting = new AbortController()
	const runSignal = ctx.abortController.signal
	const cancelWait = () => waiting.abort(runSignal.reason)
	runSignal.addEventListener('abort', cancelWait, { once: true })
	if (runSignal.aborted) cancelWait()
	try {
		await Promise.race([
			...(inbox ? [inbox.waitForArrival(graceMs, waiting.signal)] : []),
			...(jobs ? [jobs.waitForArrival(graceMs, waiting.signal)] : []),
			...(ctx.waitForInbound ? [ctx.waitForInbound(waiting.signal)] : []),
		])
	} catch (error) {
		if (!runSignal.aborted) throw error
	} finally {
		waiting.abort()
		runSignal.removeEventListener('abort', cancelWait)
	}
	runSignal.throwIfAborted()

	const arrived = ctx.completionInbox?.drain() ?? []
	if (arrived.length > 0) {
		ctx.runMgr.pushMessage(
			createRuntimeContextMessage(formatCompletionNotification(arrived), 'task-completion'),
		)
	}
	const exited = deliverAwaitedJobExits(ctx)
	const inbound = deliverInbound()
	if (arrived.length === 0 && !exited && inbound === 0) return false
	await ctx.emitEvent({
		type: 'iteration_completed',
		runId: ctx.runMgr.id,
		iteration: iterationNum,
		hasToolCalls,
	})
	yield* ctx.drainPending()
	return true
}

/**
 * Put the job exits this hold was waiting for in front of the model.
 *
 * Through `jobNotices`, which is the channel a job exit already travels on
 * — `attachNotice` rides it out on the next tool result — rather than a
 * second one built for this path. A turn that called no tools has no such
 * result, so the queued text becomes a `runtime-context` message instead,
 * exactly as `deliverInbound` does for steering that found no tool result
 * to attach to.
 *
 * That drain is also what keeps one exit from being delivered twice: the
 * channel hands its text over once, so an exit already attached to a tool
 * result earlier in the turn leaves nothing here — and the record of it
 * went with that delivery, so this returns `false` rather than buying a
 * turn to re-read what the model has read.
 *
 * `takeDelivery` is what pairs the two. Taking the exits first and then
 * finding no notice would discard them, which is the one way this path
 * can lose an exit outright; neither is taken unless both are there.
 *
 * The channel is not per-job, so the text taken here can include a notice
 * for a job nobody awaited that ended while the hold was open. Delivering
 * it is right — it is unread either way, and the alternative is stranding
 * it — but it is not a reason to WAIT, which is why what opens this hold
 * is `AwaitedJobs`, and the two are asked separately.
 */
export function deliverAwaitedJobExits(ctx: IterationContext): boolean {
	const delivered = ctx.awaitedJobs?.takeDelivery(() => ctx.jobNotices?.drain())
	if (!delivered) return false

	ctx.log.info('Delivering a background job exit the run held open for', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.jobs': delivered.exits.map((job) => job.id),
	})
	ctx.runMgr.pushMessage(createRuntimeContextMessage(formatJobNote(delivered.text), 'job-exit'))
	return true
}

/**
 * Account for outstanding work on the way out: deliver what arrived, and
 * say what did not.
 *
 * A run that ends with a worker outstanding must not leave the impression
 * that the worker's result was delivered. There are exactly two honest
 * outcomes and this does both:
 *
 *  - **What has already arrived is delivered.** It makes no false claim,
 *    and dropping it is pure loss — the message rides out on
 *    `Run.messages`, so a host reads it and the next turn of a continued
 *    thread starts with it. This does NOT wait: a hold buys the model a
 *    turn in which to USE a result, and on an exit whose answer is already
 *    decided there is no such turn, so waiting would delay a settled answer
 *    to append text this run will not read. The bounded hold stays where it
 *    was, on the exits that do have a turn left.
 *  - **What is still running is NAMED, not cancelled.** Giving up on a wait
 *    is a statement about the waiter, not about the work — the rule
 *    `wait-with-idle-bound.ts` already states for the same subsystem — and
 *    "the parent answered early" is a weaker warrant for killing a child
 *    than "the clock ran out", not a stronger one. Killing a worker that
 *    may be mid-write is a policy only the host can judge, and it has
 *    `cancel_task` and the run controller to judge it with.
 */
export function settleOutstandingWork(ctx: IterationContext): void {
	deliverArrivedCompletions(ctx)
	deliverArrivedJobExits(ctx)
	recordAbandonedWork(ctx)
}

/** Work this run walked away from. See {@link settleOutstandingWork}. */
export function recordAbandonedWork(ctx: IterationContext): void {
	const abandoned = ctx.completionInbox?.outstandingTaskIds ?? []
	if (abandoned.length > 0) {
		ctx.log.warn('Run ended with delegated work still running', {
			[NAMZU.RUN_ID]: ctx.runMgr.id,
			'namzu.runtime.tasks': abandoned,
		})
		ctx.runMgr.setAbandonedTaskIds(abandoned)
	}

	// The same statement for a job the model was waiting on when the grace
	// ran out. Only awaited ones: a job nobody waited for was never work
	// this run was holding, so naming it would report an abandonment that
	// did not happen.
	const abandonedJobs = ctx.awaitedJobs?.outstandingJobIds ?? []
	if (abandonedJobs.length === 0) return

	ctx.log.warn('Run ended with an awaited background job still running', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.jobs': abandonedJobs,
	})
	ctx.runMgr.setAbandonedJobIds(abandonedJobs)
}

export function deliverArrivedCompletions(ctx: IterationContext): void {
	const unheard = ctx.completionInbox?.drain() ?? []
	if (unheard.length === 0) return

	// Fix the run's answer BEFORE appending anything after it.
	//
	// `RunPersistence.resolveResult` walks the message tail backwards and
	// stops at the first non-assistant message, and it runs at
	// `markCompleted` — which is AFTER this. So a notification appended
	// after the final assistant turn makes the run's own answer
	// unreachable. Measured, on a run whose model had just said "THIS IS
	// THE RUN ANSWER.": `run.result` came back `undefined`. That trades a
	// lost worker result for a lost RUN result, which is strictly worse
	// than the defect this delivery exists to fix.
	//
	// Materialising resolves it while the tail is still the assistant's;
	// pinning it means the later re-resolution cannot undo the fix. Only
	// when there is something to pin: on the cancelled and thrown paths
	// there may be no answer, and pinning an empty string there would
	// suppress whatever the error path assembles.
	const answer = ctx.runMgr.materializeResult()
	if (answer.length > 0) ctx.runMgr.setResult(answer)

	ctx.log.info('Delivering task completions the run would have settled over', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.tasks': unheard.map((h) => h.taskId),
	})
	ctx.runMgr.pushMessage(
		createRuntimeContextMessage(formatCompletionNotification(unheard), 'task-completion'),
	)
}

/**
 * The job half of {@link deliverArrivedCompletions}: an exit that arrived
 * too late to earn a turn is still delivered on the way out.
 *
 * The window this closes is one tick wide and it is nobody else's. An
 * awaited job that exits between the hold's grace expiring and the run
 * settling was never delivered — the hold had already looked — and is no
 * longer named either, because the exit took it off the outstanding list
 * on its way past, so `abandonedJobIds` would be lying to claim it. The
 * host's own listener is no help: the CLI queues an exit for the next
 * turn only when no run is in flight, and this one is still in flight.
 * Delivered here it reaches `Run.messages`, so the transcript has it and
 * a continued thread opens with it.
 *
 * Before `recordAbandonedWork`, which then reports only what is still
 * running, and after `deliverArrivedCompletions`, so the two appended
 * messages land in the order the work finished in.
 */
export function deliverArrivedJobExits(ctx: IterationContext): void {
	const delivered = ctx.awaitedJobs?.takeDelivery(() => ctx.jobNotices?.drain())
	if (!delivered) return

	// Fix the run's answer BEFORE appending anything after it — the same
	// `resolveResult` tail walk `deliverArrivedCompletions` explains just
	// above, and the same guard against pinning an empty one.
	const answer = ctx.runMgr.materializeResult()
	if (answer.length > 0) ctx.runMgr.setResult(answer)

	ctx.log.info('Delivering a background job exit the run would have settled over', {
		[NAMZU.RUN_ID]: ctx.runMgr.id,
		'namzu.runtime.jobs': delivered.exits.map((job) => job.id),
	})
	ctx.runMgr.pushMessage(createRuntimeContextMessage(formatJobNote(delivered.text), 'job-exit'))
}
