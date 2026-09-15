import type { BackgroundJob, BackgroundJobRegistry } from './registry.js'

/**
 * What this adapter needs from a registry: the jobs' exits, and one job's
 * current status. Structural rather than the class, for the reason
 * `BackgroundJobRegistryRef` is: the kernel passes the real registry, and a
 * test that needs two exits and nothing else should not have to spawn
 * processes to produce them.
 */
export type AwaitedJobSource = Pick<BackgroundJobRegistry, 'get' | 'onExit'>

/**
 * Background jobs the model SAID it is waiting on.
 *
 * `CompletionInbox` gives a run a bounded, zero-token wait for a delegated
 * task nobody is blocked on, and `holdForOutstandingWork` spends it: the
 * model stops calling tools, the loop races the inbox against operator input,
 * and the run only settles once the result is in the transcript or the grace
 * is gone. Background shell jobs had none of it — so a model that started a
 * job and then had nothing left to do improvised, and the recorded run
 * (research/resident/results/2026-09-14-exploration-policy-terra-tui.json)
 * shows what that costs: six `job read` polls, three `job list` polls and a
 * `sleep 30`, each one a full context resend.
 *
 * This is the same three-method shape the hold already races —
 * {@link hasPendingWork}, {@link waitForArrival}, {@link drain} — over the
 * job registry instead of the task gateway.
 *
 * **Intent is stated, never inferred.** A job is only outstanding here once
 * `wait_for_job` named it (see {@link expect}); job existence means nothing.
 * That is the same distinction `CompletionInbox.expect` draws for a
 * background task, and it is what keeps a dev server or a file watcher —
 * started precisely so it would keep running — from holding every run of the
 * session open for its grace period. The model that wants to wait says so.
 */
export class AwaitedJobs {
	/** Awaited and still running. Nothing else can hold a run open. */
	private readonly outstanding = new Set<string>()
	/** Exits since the last {@link drain}. */
	private exits: BackgroundJob[] = []
	private readonly arrivals = new Set<() => void>()
	private detach?: () => void

	constructor(
		private readonly source: AwaitedJobSource,
		/** Whose jobs these are — the run or the session the jobs are bound to. */
		private readonly owner: string,
		/**
		 * Whether the exit notice this run queues for the model is still
		 * unread.
		 *
		 * An exit is work only until the model has seen it, and this adapter is
		 * not what shows it: the text rides out on the next tool result
		 * (`attachNotice`), which is what normally happens, long before any
		 * hold opens. Without this the queue entry left behind by that delivery
		 * would keep {@link hasPendingWork} true and make {@link waitForArrival}
		 * resolve at once — and since the hold races its legs, an entry for an
		 * exit the model read ten minutes ago would end the wait the delegated
		 * task leg had just opened for work that really was outstanding.
		 *
		 * `CompletionInbox.claim` draws the same line on the task side. It can
		 * name the task, because the call that delivers a completion knows
		 * which one it delivered; a notice is text by the time it reaches the
		 * tool result, so this asks the channel instead.
		 *
		 * Absent means nothing else consumes the notices, so a recorded exit is
		 * unread by definition.
		 */
		private readonly unreadNotice?: () => boolean,
	) {}

	/**
	 * Start listening.
	 *
	 * Returns the detach, and attaching twice is a no-op rather than a second
	 * subscription — the same rule `CompletionInbox.attach` follows, for the
	 * same reason: two subscriptions would record each exit twice.
	 */
	attach(): () => void {
		if (this.detach) return this.detach
		this.detach = this.source.onExit((job) => {
			// `onExit` is a broadcast over a registry a host may share between
			// runs, and the filter is the same one the exit-notice channel
			// applies in `runtime/query/index.ts`.
			if (job.owner !== this.owner) return
			// `outstanding` is the gate, so an id nobody awaited is ignored and
			// a second announcement for the same job cannot queue twice.
			if (!this.outstanding.delete(job.id)) return
			this.exits.push(job)
			for (const wake of [...this.arrivals]) wake()
		})
		return this.detach
	}

	/**
	 * Say that the model is waiting on this job's exit.
	 *
	 * Called by `wait_for_job`, and by nothing else: the wait is the whole
	 * signal. A job that has ALREADY stopped is not recorded, because the
	 * call that marks it is the same call that returns its output — holding
	 * the run open afterwards would buy a turn to read a result the model has
	 * just read. `CompletionInbox.expect` skips an already-claimed task for
	 * the same reason.
	 *
	 * An id the registry does not know is ignored rather than raised: the
	 * caller is about to fail on it anyway, and a marking call is not the
	 * place that decides what an unknown job means.
	 */
	expect(id: string): void {
		let job: BackgroundJob
		try {
			job = this.source.get(id)
		} catch {
			return
		}
		if (job.owner !== this.owner) return
		if (job.status !== 'running') return
		this.outstanding.add(id)
	}

	/**
	 * Recorded exits the model has not been shown yet.
	 *
	 * See the `unreadNotice` constructor argument: a queued exit whose notice
	 * has already been delivered is history, not pending work.
	 */
	private get unreadExits(): boolean {
		if (this.exits.length === 0) return false
		return this.unreadNotice?.() ?? true
	}

	/** Whether an awaited job is still running, or one has exited unread. */
	get hasPendingWork(): boolean {
		return this.unreadExits || this.outstanding.size > 0
	}

	/**
	 * Wait for the next awaited job's exit, deadline or abort, whichever comes
	 * first. Aborting releases only this waiter; the jobs are untouched.
	 *
	 * Bounded by the caller, exactly as `CompletionInbox.waitForArrival` is: a
	 * job that never exits — a dev server someone did await — must not keep a
	 * run open, and only the run's own budget knows how long is long enough.
	 */
	waitForArrival(timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return Promise.resolve()
		if (this.unreadExits) return Promise.resolve()
		if (this.outstanding.size === 0) return Promise.resolve()

		return new Promise((resolve) => {
			const finish = (): void => {
				clearTimeout(timer)
				this.arrivals.delete(finish)
				signal?.removeEventListener('abort', finish)
				resolve()
			}
			const timer = setTimeout(finish, timeoutMs)
			// `unref` where the runtime has it, so a pending wait never keeps a
			// process alive past the job it was waiting for.
			;(timer as { unref?: () => void }).unref?.()

			this.arrivals.add(finish)
			signal?.addEventListener('abort', finish, { once: true })
			if (signal?.aborted) finish()
		})
	}

	/**
	 * Take every exit recorded since the last call, leaving none behind.
	 *
	 * Draining rather than peeking, for the reason `CompletionInbox.drain`
	 * gives: an exit that stays queued after being delivered is a duplicate
	 * waiting to happen.
	 */
	drain(): readonly BackgroundJob[] {
		if (this.exits.length === 0) return []
		const exits = this.exits
		this.exits = []
		return exits
	}

	/**
	 * Awaited jobs still running.
	 *
	 * Read when a run ends, so it can say which wait it walked away from.
	 * Nothing here is stopped by being read — the ids are a statement, and a
	 * job's lifetime belongs to whoever owns it.
	 */
	get outstandingJobIds(): readonly string[] {
		return [...this.outstanding]
	}

	/**
	 * Stop listening. Safe to call more than once.
	 *
	 * A run that ends without this leaves its listener on a registry the host
	 * reuses across runs — the leak `CompletionInbox.close` exists to prevent,
	 * on the other subsystem.
	 */
	close(): void {
		this.detach?.()
		this.detach = undefined
		this.outstanding.clear()
		this.exits = []
		// Release anyone still waiting. A closed adapter would otherwise hold
		// them to their own deadline for an exit that can no longer reach them.
		for (const wake of [...this.arrivals]) wake()
		this.arrivals.clear()
	}
}
