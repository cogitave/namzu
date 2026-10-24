/**
 * The "needs your approval" notice, held back until the person has had a
 * chance to answer on their own.
 *
 * A permission notice is sent only when the
 * dialog has been open for 6000 ms with no keypress since it opened (or since
 * the last one), so someone sitting at the screen is never pinged about a
 * prompt they are already reading. The same delay applies to the notification
 * hooks. Answering the dialog cancels the notice; a keypress postpones it.
 *
 * Pure of React and of the terminal: the clock and the timers are handed in so
 * a test advances time itself instead of waiting for it.
 */

/** How long an open permission dialog waits for a keypress before it notifies. */
export const APPROVAL_NOTIFICATION_MS = 6_000

export interface ApprovalNotifierDeps {
	readonly now: () => number
	readonly setTimer: (run: () => void, ms: number) => unknown
	readonly clearTimer: (handle: unknown) => void
	/** When the person last pressed a key. */
	readonly lastInteractionAt: () => number
	/** Whether a dialog that wants an answer is still on screen. */
	readonly isDialogOpen: () => boolean
	readonly send: () => void
	readonly delayMs?: number
}

export class ApprovalNotifier {
	readonly #deps: ApprovalNotifierDeps
	#timer: unknown = null
	#openedAt = 0
	#disposed = false

	constructor(deps: ApprovalNotifierDeps) {
		this.#deps = deps
	}

	get #delay(): number {
		return this.#deps.delayMs ?? APPROVAL_NOTIFICATION_MS
	}

	/** A dialog took the screen: count down. A newer dialog replaces an older count. */
	dialogOpened(): void {
		if (this.#disposed) return
		this.#cancel()
		this.#openedAt = this.#deps.now()
		this.#arm(this.#delay)
	}

	/** The dialog was answered or dismissed. */
	dialogClosed(): void {
		this.#cancel()
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

	#arm(ms: number): void {
		this.#timer = this.#deps.setTimer(() => {
			this.#timer = null
			this.#fire()
		}, ms)
	}

	#fire(): void {
		const deps = this.#deps
		if (this.#disposed || !deps.isDialogOpen()) return
		const quietSince = Math.max(this.#openedAt, deps.lastInteractionAt())
		const quietFor = deps.now() - quietSince
		if (quietFor < this.#delay) {
			// A key was pressed meanwhile: try again once the quiet is long enough.
			this.#arm(this.#delay - quietFor)
			return
		}
		deps.send()
	}
}
