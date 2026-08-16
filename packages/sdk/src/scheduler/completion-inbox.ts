import { wrapUntrusted } from '../tools/untrusted-envelope.js'
import type { TaskHandle, TaskScheduler } from '../types/agent/scheduler.js'
import { isTerminalAgentTaskState } from '../types/agent/task.js'
import type { TaskId } from '../types/ids/index.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import { type Logger, resolveLogger } from '../utils/logger.js'

/**
 * How many unclaimed announcements may wait for an owner at once.
 *
 * Derived from what it has to survive rather than picked. An entry lives here
 * only between a gateway announcing a task and this run saying whether the
 * task is its own — one microtask, for a launch made through `create_task`.
 * The number that has to fit is therefore the largest batch of launches that
 * can be in flight together before any of them is claimed: one assistant turn
 * of `create_task` blocks, which this codebase's own tool description
 * illustrates as "fan out 8 specialists" and which a provider bounds at a few
 * dozen tool_use blocks per response. 32 clears that with room, and a batch
 * bigger than it is announced rather than silently truncated.
 *
 * The ceiling is what stops this being the retention half of the leak it
 * exists beside: on a gateway shared with other runs, every foreign completion
 * lands here and is never claimed, and each one holds a whole worker result —
 * kilobytes at least. Bounded, the cost is 32 handles; unbounded, it is every
 * result every other run on that gateway ever produced.
 */
const UNOWNED_BUFFER_LIMIT = 32

/**
 * Completions that finished with nobody left to hear them.
 *
 * A worker's result reaches the supervisor as the `tool_result` of the
 * `create_task` that launched it. That works whenever the launching call is
 * still the live path — but it is not the only way a task ends:
 *
 *  - the launching tool hit its deadline and the executor returned
 *    *"timed out… it may still be running"* to the model. The worker then
 *    finished normally, holding a result nothing would ever read.
 *  - the task was launched in the background on purpose, so there is no
 *    call waiting on it by design.
 *
 * In both cases the completion exists, the gateway remembers it, and the
 * model is never told. That is the gap this closes: the run subscribes once,
 * every settled task lands here, and anything a tool did NOT hand over
 * inline is drained into the transcript as a notification the next turn can
 * read.
 *
 * The disambiguation is the whole design. An earlier version of the envelope
 * path was removed (`dc16d58`) because it fired for completions the blocking
 * tool had ALREADY delivered, so the supervisor saw every result twice —
 * once correctly as a `tool_result`, once as an orphan envelope. Removing it
 * fixed the duplicate and left the abandoned case with no channel at all.
 * Claiming is what tells the two apart: a tool that delivers a completion
 * says so, and only unclaimed completions become envelopes.
 *
 * It attaches through `onTaskCompleted`, which every `TaskScheduler` already
 * has, so a host gateway needs no change to take part — a host that was
 * firing completions into a listener set with no listeners now has one.
 */
export class CompletionInbox {
	private readonly unheard = new Map<TaskId, TaskHandle>()
	private readonly claimed = new Set<TaskId>()
	/** Launched with nothing waiting on it, and not settled yet. */
	private readonly outstanding = new Set<TaskId>()
	/**
	 * Tasks THIS run launched.
	 *
	 * `onTaskCompleted` is a broadcast and `TaskHandle` carries no run id, so
	 * a gateway shared between two supervisors hands every completion to both
	 * of their inboxes. Measured: with two inboxes on one gateway, the run
	 * that launched nothing drained the other run's task and would have been
	 * told "a task you launched has finished" — a claim that was false, over
	 * another run's worker output, in a transcript whose model then has to
	 * account for it.
	 *
	 * A shared gateway is not an abuse of the API: `SupervisorAgentConfig`
	 * takes one, and a host that owns a gateway naturally reuses it.
	 */
	private readonly ours = new Set<TaskId>()
	/**
	 * Announcements that arrived before anyone said whose task it was.
	 *
	 * `gateway.createTask` resolves one microtask before its caller can name
	 * the task, and a worker that finishes inside that window is announced
	 * first — `LocalTaskScheduler` attaches its completion continuation before
	 * it returns the handle, so the ordering is guaranteed to be reachable
	 * rather than merely possible. Dropping an unowned announcement outright
	 * would therefore turn the leak fix into a LOST RESULT for exactly the
	 * fast completions the inbox exists to catch.
	 *
	 * So they wait here, and ownership may be claimed retroactively. What
	 * makes that safe rather than a second leak is the bound: on a gateway
	 * shared with other runs this fills with completions that will never be
	 * claimed, each holding a whole worker result.
	 */
	private readonly unowned = new Map<TaskId, TaskHandle>()
	private readonly arrivals = new Set<() => void>()
	private detach?: () => void
	/** Kept for {@link launched}: the source of truth about a task's state. */
	private gateway?: TaskScheduler

	/**
	 * `log` is optional and unresolved until it is actually needed (the
	 * eviction-warning path in `hold()`), same reason as `LocalTaskScheduler`.
	 */
	constructor(private readonly log?: Logger) {}

	/**
	 * Start listening.
	 *
	 * Returns a detach function; calling `attach` twice is a no-op rather
	 * than a second subscription, because a doubly-attached inbox would
	 * queue every completion twice and reproduce the exact duplicate this
	 * class exists to prevent.
	 */
	attach(gateway: TaskScheduler): () => void {
		if (this.detach) return this.detach
		this.gateway = gateway
		this.detach = gateway.onTaskCompleted((handle) => {
			// Not known to be ours — either another run's worker on a shared
			// gateway, or ours announced before the launch could be recorded.
			// The two are indistinguishable here, so it waits rather than
			// being delivered or dropped. See {@link unowned}.
			if (!this.ours.has(handle.taskId)) {
				this.hold(handle)
				return
			}
			// A completion claimed before it was announced — a tool that
			// finished its wait faster than the listener ran — is already
			// delivered. Nothing to queue.
			this.outstanding.delete(handle.taskId)
			if (this.claimed.has(handle.taskId)) return
			this.unheard.set(handle.taskId, handle)
			for (const wake of this.arrivals) wake()
		})
		return this.detach
	}

	/**
	 * Park an announcement nobody has claimed yet, evicting the oldest if the
	 * buffer is full.
	 *
	 * An eviction is logged at WARN, and that is not decoration. If the entry
	 * turned out to be ours, its completion has just been dropped — the
	 * original defect, wearing the cap as a disguise — and the only evidence
	 * would otherwise be an absence, which is precisely the shape of failure
	 * this whole session has been closing. A reader who sees this line knows
	 * where to look.
	 */
	private hold(handle: TaskHandle): void {
		if (this.unowned.size >= UNOWNED_BUFFER_LIMIT && !this.unowned.has(handle.taskId)) {
			const oldest = this.unowned.keys().next()
			if (!oldest.done) {
				this.unowned.delete(oldest.value)
				resolveLogger(this.log)
					.child({ [SCOPE_ATTRIBUTE]: 'scheduler/completion-inbox' })
					.warn(
						"Unclaimed completion buffer is full — dropped the oldest. If that task was this run's, its result is now unreachable; raise UNOWNED_BUFFER_LIMIT or launch fewer tasks per turn.",
						{
							'namzu.scheduler.dropped': oldest.value,
							'namzu.scheduler.limit': UNOWNED_BUFFER_LIMIT,
						},
					)
			}
		}
		this.unowned.set(handle.taskId, handle)
	}

	/**
	 * Say that this run launched the task.
	 *
	 * Required before anything about the task can reach this inbox — see
	 * {@link ours}. Every launch says it, whether or not something is waiting
	 * on the result, because the case the inbox exists for is precisely the
	 * one where the waiter gave up.
	 *
	 * **The late-announcement branches are not defensive.**
	 * `gateway.createTask` resolves one microtask before its caller can say
	 * who owns the task, and a worker that finishes inside that window is
	 * announced first — the same ordering that used to leave a permanent
	 * pending flag. Without recovery the ownership check would turn that race
	 * from a stale flag into a lost result.
	 *
	 * There are two, and the second is the safety net for the first. The
	 * buffer ({@link unowned}) needs nothing from the gateway beyond the
	 * announcement it already made. Asking `getTask` covers the case the
	 * buffer cannot — an announcement evicted under load — but it rests on a
	 * gateway still knowing about a task it has just settled, which is a
	 * property of the implementations here rather than of the `TaskScheduler`
	 * contract, and `getTask`'s own docs now say so.
	 */
	launched(taskId: TaskId): void {
		if (this.ours.has(taskId)) return
		this.ours.add(taskId)

		if (this.claimed.has(taskId) || this.unheard.has(taskId)) return

		const parked = this.unowned.get(taskId)
		if (parked) {
			this.unowned.delete(taskId)
			this.unheard.set(taskId, parked)
			for (const wake of [...this.arrivals]) wake()
			return
		}

		const settled = this.gateway?.getTask(taskId)
		if (!settled || !isTerminalAgentTaskState(settled.state)) return
		this.unheard.set(taskId, settled)
		for (const wake of [...this.arrivals]) wake()
	}

	/**
	 * Say that a task was launched with nothing waiting on it.
	 *
	 * {@link launched} plus the statement that no call will deliver the
	 * result. Without the second half the inbox can only see completions that
	 * have already happened, and a run whose supervisor launched a background
	 * worker and then answered would settle while the worker was still going —
	 * throwing away the very result the launch existed to produce. Knowing a
	 * task is outstanding is what lets the loop hold the run open for it.
	 */
	expect(taskId: TaskId): void {
		this.launched(taskId)
		if (this.claimed.has(taskId)) return
		this.outstanding.add(taskId)
	}

	/** Whether anything is either waiting to be told or still running. */
	get hasPendingWork(): boolean {
		return this.unheard.size > 0 || this.outstanding.size > 0
	}

	/**
	 * Wait for the next completion, or for the deadline, whichever comes first.
	 *
	 * Bounded on purpose. A worker that never finishes must not hold a run
	 * open forever, and the caller decides how long "long enough" is — the
	 * run's own budget is the only thing that knows.
	 */
	waitForArrival(timeoutMs: number): Promise<void> {
		if (this.unheard.size > 0) return Promise.resolve()
		if (this.outstanding.size === 0) return Promise.resolve()

		return new Promise((resolve) => {
			const timer = setTimeout(finish, timeoutMs)
			// `unref` where the runtime has it, so a pending wait never keeps
			// a process alive past the work it was waiting for.
			;(timer as { unref?: () => void }).unref?.()

			function finish(): void {
				clearTimeout(timer)
				wake.done = true
				resolve()
			}

			const wake = Object.assign(
				() => {
					if (!wake.done) {
						this.arrivals.delete(wake)
						finish()
					}
				},
				{ done: false },
			)
			this.arrivals.add(wake)
		})
	}

	/**
	 * Say that this completion reached the model as a `tool_result`.
	 *
	 * Idempotent, and safe to call before the completion is announced: the
	 * claim is remembered so a late announcement does not re-queue it.
	 */
	claim(taskId: TaskId): void {
		this.claimed.add(taskId)
		this.unheard.delete(taskId)
		this.outstanding.delete(taskId)
	}

	/** Whether anything is waiting to be told. */
	get hasUnheard(): boolean {
		return this.unheard.size > 0
	}

	/**
	 * Tasks this run launched that are still running.
	 *
	 * Read when a run ends, so it can say which work it walked away from.
	 * Nothing here is cancelled by being read — the ids are a statement, and
	 * what to do about them is the host's call.
	 */
	get outstandingTaskIds(): readonly TaskId[] {
		return [...this.outstanding]
	}

	/**
	 * Take every unheard completion, leaving the inbox empty.
	 *
	 * Draining rather than peeking: a notification that stays queued after
	 * being delivered is the duplicate-delivery bug in a different costume.
	 */
	drain(): TaskHandle[] {
		if (this.unheard.size === 0) return []
		const handles = [...this.unheard.values()]
		this.unheard.clear()
		for (const handle of handles) {
			this.claimed.add(handle.taskId)
			// A delivered result is not pending WORK, and `outstanding` can
			// still be holding this id — the listener clears it, but only if
			// the announcement came AFTER the launching tool said `expect`.
			// The other order is reachable: `expect` runs one microtask after
			// `gateway.createTask` resolves, and the gateway's own completion
			// callback can win that race for a task that finished fast. Then
			// `expect` re-adds an id the listener had nothing to remove, and
			// nothing else ever takes it off — so `hasPendingWork` stayed true
			// for the rest of the run and every attempt to settle paid the
			// full grace period waiting for a result already in the transcript.
			//
			// Symmetric with `claim`, which clears it for the same reason.
			this.outstanding.delete(handle.taskId)
		}
		return handles
	}

	/**
	 * Stop expecting a task that is never going to arrive.
	 *
	 * Cancelling is the case this exists for. `expect` puts a task on the
	 * outstanding list and only a COMPLETION takes it off, so a cancelled
	 * worker left `hasPendingWork` true for the rest of the run — and every
	 * attempt to settle then paid the full grace period waiting for a result
	 * that had been called off.
	 */
	forget(taskId: TaskId): void {
		this.outstanding.delete(taskId)
		// `unheard` is deliberately NOT touched.
		//
		// The two sets mean different things. `outstanding` is pending WORK,
		// and cancelling is exactly the statement that it should stop being
		// waited for. `unheard` is a RESULT that already exists — the worker
		// finished, the completion arrived, and it is queued for the next
		// drain. Clearing it here destroyed that.
		//
		// The window is small and entirely reachable: nothing has told the
		// model the worker finished, and `cancel_task` says it cancels a
		// running task, so cancelling one that has just completed is the
		// obvious move rather than a mistake. The run then reports "cancelled"
		// over work that was done and output that no longer exists anywhere.
		//
		// Note the asymmetry with `claim`, which does clear `unheard` — and is
		// right to, because there a tool has just handed the model the same
		// result. This one hands over nothing.
		for (const wake of [...this.arrivals]) wake()
	}

	/**
	 * Stop listening. Safe to call more than once.
	 *
	 * A run that ends without this leaves its listener on the gateway
	 * forever. On a gateway the host reuses that is measurable — three
	 * sequential runs left three live subscriptions, each still holding its
	 * run's handles — and the listener set only grows. Ownership stops a
	 * retained listener from DELIVERING another run's work; closing is what
	 * stops it existing.
	 */
	close(): void {
		this.detach?.()
		this.detach = undefined
		this.gateway = undefined
		this.unheard.clear()
		this.outstanding.clear()
		this.ours.clear()
		this.claimed.clear()
		this.unowned.clear()
		// Release anyone still waiting. A closed inbox would otherwise hold
		// them to their own deadline for a completion that can no longer come.
		for (const wake of [...this.arrivals]) wake()
		this.arrivals.clear()
	}
}

/** How much of a worker's output rides in the notification itself. */
const NOTIFICATION_OUTPUT_LIMIT = 4_000

const NOTIFICATION_DELIMITER = /task-notification/gi

/**
 * Defang this file's own delimiter inside a worker's text.
 *
 * Without it a worker whose output contains `</task-notification>` closes the
 * block early, and everything it wrote after that sits OUTSIDE the boundary —
 * reading as ordinary transcript rather than as a delegate's material.
 * Measured before the fix: two closing tags in one notification, with
 * attacker-controlled text between them.
 *
 * The replacement swaps the hyphen for an underscore rather than appending a
 * suffix, for the reason `neutralizeEnvelopeDelimiter` records: a replacement
 * that still CONTAINS the token is found again by a second pass or by any
 * looser matcher downstream. `task_notification` shares no substring with the
 * real delimiter while staying legible.
 *
 * The nested `<namzu-untrusted>` block defangs its own delimiter; these two
 * patterns are disjoint, so the order they run in does not matter.
 */
function neutralizeNotificationDelimiter(content: string): string {
	return content.replace(NOTIFICATION_DELIMITER, 'task_notification')
}

/**
 * The message a supervisor reads when a worker it stopped waiting for
 * finishes.
 *
 * It carries the task id, because without one the model cannot say which of
 * five workers this was, and it carries the output, because a notification
 * that only says "done" forces exactly the follow-up call this mechanism
 * exists to remove. Long output is truncated with the task id repeated in
 * the truncation notice, so the full text stays one `wait_for_task` away and
 * the model knows which id to ask for — that tool takes a `task_id` and
 * returns immediately for a task that has already finished, where the
 * listing takes only a state filter and could not have been followed.
 */
export function formatCompletionNotification(handles: readonly TaskHandle[]): string {
	const blocks = handles.map((handle) => {
		const durationMs = handle.completedAt ? handle.completedAt - handle.createdAt : undefined
		const output = handle.result?.result ?? handle.result?.lastError ?? ''
		const overLimit = output.length > NOTIFICATION_OUTPUT_LIMIT
		const shown = overLimit ? output.slice(0, NOTIFICATION_OUTPUT_LIMIT) : output

		// Framed for the same reason the blocking `create_task` frames its
		// return value, and this path is the one that had nothing. A delegated
		// worker is the component most likely to have consumed material nobody
		// in this run authored — it was told to read and report, and it ran
		// `read`, `grep`, `fetch` over whatever it found — and its text lands
		// in a parent that typically holds the broader tool grant. The same
		// bytes were being wrapped on one path and pasted bare on this one.
		//
		// The metadata above stays OUTSIDE the envelope: the task id, the agent
		// and the state are this kernel's own statements, and framing them as
		// untrusted material would tell the model to discount the only part of
		// the message it can rely on.
		const body =
			shown.length > 0
				? wrapUntrusted(
						{
							kind: 'agent-result',
							attributes: { agent: handle.agentId, task: handle.taskId },
							provenance: `This is the output of the delegated agent "${handle.agentId}", not this agent's own work.`,
						},
						neutralizeNotificationDelimiter(shown),
					)
				: '(the task produced no output)'

		const lines = [
			`task_id: ${handle.taskId}`,
			`agent: ${handle.agentId}`,
			`state: ${handle.state}`,
			...(durationMs !== undefined ? [`duration_ms: ${durationMs}`] : []),
			'',
			body,
			// Outside the envelope, deliberately: this sentence is an
			// instruction from the kernel about how to get the rest, and inside
			// the envelope the model has just been told not to treat the
			// contents as instructions.
			//
			// `wait_for_task`, not `agent_task_list` — the listing takes only a
			// state filter, so an instruction to call it "with task_id" named a
			// parameter that does not exist and could not be followed. On an
			// already-finished task the wait returns immediately.
			...(overLimit
				? [`… truncated. Call wait_for_task with task_id "${handle.taskId}" for the full output.`]
				: []),
		]
		return `<task-notification>\n${lines.join('\n')}\n</task-notification>`
	})

	const preamble =
		handles.length === 1
			? 'A task you launched has finished. This is its result — you were not waiting on it, so it arrives here rather than as a tool result.'
			: `${handles.length} tasks you launched have finished. These are their results — you were not waiting on them, so they arrive here rather than as tool results.`

	return `${preamble}\n\n${blocks.join('\n\n')}`
}
