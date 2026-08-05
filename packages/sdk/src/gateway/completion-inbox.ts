import type { TaskGateway, TaskHandle } from '../types/agent/gateway.js'
import type { TaskId } from '../types/ids/index.js'

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
 * It attaches through `onTaskCompleted`, which every `TaskGateway` already
 * has, so a host gateway needs no change to take part — a host that was
 * firing completions into a listener set with no listeners now has one.
 */
export class CompletionInbox {
	private readonly unheard = new Map<TaskId, TaskHandle>()
	private readonly claimed = new Set<TaskId>()
	/** Launched with nothing waiting on it, and not settled yet. */
	private readonly outstanding = new Set<TaskId>()
	private readonly arrivals = new Set<() => void>()
	private detach?: () => void

	/**
	 * Start listening.
	 *
	 * Returns a detach function; calling `attach` twice is a no-op rather
	 * than a second subscription, because a doubly-attached inbox would
	 * queue every completion twice and reproduce the exact duplicate this
	 * class exists to prevent.
	 */
	attach(gateway: TaskGateway): () => void {
		if (this.detach) return this.detach
		this.detach = gateway.onTaskCompleted((handle) => {
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
	 * Say that a task was launched with nothing waiting on it.
	 *
	 * Without this the inbox can only see completions that have already
	 * happened, and a run whose supervisor launched a background worker and
	 * then answered would settle while the worker was still going — throwing
	 * away the very result the launch existed to produce. Knowing a task is
	 * outstanding is what lets the loop hold the run open for it.
	 */
	expect(taskId: TaskId): void {
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
	 * Take every unheard completion, leaving the inbox empty.
	 *
	 * Draining rather than peeking: a notification that stays queued after
	 * being delivered is the duplicate-delivery bug in a different costume.
	 */
	drain(): TaskHandle[] {
		if (this.unheard.size === 0) return []
		const handles = [...this.unheard.values()]
		this.unheard.clear()
		for (const handle of handles) this.claimed.add(handle.taskId)
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

	/** Stop listening. Safe to call more than once. */
	close(): void {
		this.detach?.()
		this.detach = undefined
		this.unheard.clear()
		this.outstanding.clear()
		// Release anyone still waiting. A closed inbox would otherwise hold
		// them to their own deadline for a completion that can no longer come.
		for (const wake of [...this.arrivals]) wake()
		this.arrivals.clear()
	}
}

/** How much of a worker's output rides in the notification itself. */
const NOTIFICATION_OUTPUT_LIMIT = 4_000

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
		const truncated =
			output.length > NOTIFICATION_OUTPUT_LIMIT
				? // `wait_for_task`, not `agent_task_list` — the listing takes only a
					// state filter, so an instruction to call it "with task_id" named
					// a parameter that does not exist and could not be followed. On an
					// already-finished task the wait returns immediately.
					`${output.slice(0, NOTIFICATION_OUTPUT_LIMIT)}\n… truncated. Call wait_for_task with task_id "${handle.taskId}" for the full output.`
				: output

		const lines = [
			`task_id: ${handle.taskId}`,
			`agent: ${handle.agentId}`,
			`state: ${handle.state}`,
			...(durationMs !== undefined ? [`duration_ms: ${durationMs}`] : []),
			'',
			truncated.length > 0 ? truncated : '(the task produced no output)',
		]
		return `<task-notification>\n${lines.join('\n')}\n</task-notification>`
	})

	const preamble =
		handles.length === 1
			? 'A task you launched has finished. This is its result — you were not waiting on it, so it arrives here rather than as a tool result.'
			: `${handles.length} tasks you launched have finished. These are their results — you were not waiting on them, so they arrive here rather than as tool results.`

	return `${preamble}\n\n${blocks.join('\n\n')}`
}
