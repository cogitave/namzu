/**
 * The "waiting for you" notice: sent once when a finished turn has been left
 * alone for a minute.
 *
 * The condition is the reference terminal's, read from its code. Sixty seconds
 * after a turn completes, and only if all of these hold at that moment:
 *
 * - the person has not touched the keyboard since the turn completed;
 * - no dialog (a permission prompt, a picker) is on screen and no turn is running;
 * - nothing will wake the session by itself (a queued message, a session loop);
 * - this completion has not been announced already.
 *
 * Background agents or jobs that are still running do not cancel the notice:
 * it waits for them to finish and is then checked again, because "the work is
 * done and nobody is looking" is the moment worth interrupting for.
 *
 * Pure of React and of the terminal: the clock and the timers are handed in so
 * a test advances time itself instead of waiting for it.
 */

/** The reference's default (`messageIdleNotifThresholdMs`). */
export const IDLE_NOTIFICATION_MS = 60_000

export interface IdleNotifierDeps {
	readonly now: () => number
	readonly setTimer: (run: () => void, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
	/** When the person last pressed a key. */
	readonly lastInteractionAt: () => number
	readonly isTurnRunning: () => boolean
	readonly isDialogOpen: () => boolean
	/** Something queued or scheduled that will start a turn without the person. */
	readonly hasPendingWake: () => boolean
	/** A background agent, job or workflow is still running. */
	readonly hasBackgroundWork: () => boolean
	readonly send: () => void
	readonly thresholdMs?: number
}

export class IdleNotifier {
	readonly #deps: IdleNotifierDeps
	#timer: unknown = null
	#settledAt = 0
	#announcedFor = 0
	#waitingForBackground = false
	#disposed = false

	constructor(deps: IdleNotifierDeps) {
		this.#deps = deps
	}

	get #threshold(): number {
		return this.#deps.thresholdMs ?? IDLE_NOTIFICATION_MS
	}

	/** A turn started: whatever was counting down no longer applies. */
	turnStarted(): void {
		this.#cancel()
		this.#waitingForBackground = false
	}

	/** A turn finished, whatever its outcome: start counting. */
	turnSettled(): void {
		if (this.#disposed) return
		this.#settledAt = this.#deps.now()
		this.#arm()
	}

	/** Background work finished: if the notice was waiting for that, count again. */
	backgroundChanged(): void {
		if (this.#disposed || !this.#waitingForBackground) return
		if (this.#deps.hasBackgroundWork()) return
		this.#waitingForBackground = false
		this.#arm()
	}

	dispose(): void {
		this.#disposed = true
		this.#cancel()
	}

	#cancel(): void {
		if (this.#timer === null) return
		this.#deps.clearTimer(this.#timer)
		this.#timer = null
	}

	#arm(): void {
		this.#cancel()
		if (this.#deps.isTurnRunning() || this.#settledAt === 0) return
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = null
			this.#fire()
		}, this.#threshold)
	}

	#fire(): void {
		const deps = this.#deps
		if (deps.lastInteractionAt() > this.#settledAt) return
		if (deps.hasBackgroundWork()) {
			this.#waitingForBackground = true
			return
		}
		if (
			!deps.isTurnRunning() &&
			!deps.isDialogOpen() &&
			!deps.hasPendingWake() &&
			deps.now() - this.#settledAt >= this.#threshold &&
			this.#settledAt !== this.#announcedFor
		) {
			this.#announcedFor = this.#settledAt
			deps.send()
		}
	}
}
