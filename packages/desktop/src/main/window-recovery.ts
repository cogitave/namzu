import { RECOVERY_RELOAD_URL, type RecoveryCause } from './recovery-card.js'

/** Reloads allowed inside one window of time before Namzu stops and says so. */
export const MAX_AUTOMATIC_RELOADS = 3
export const RELOAD_WINDOW_MS = 60_000
/** Waits before the first, second and third automatic reload. */
export const RELOAD_DELAYS_MS: readonly number[] = [500, 2_000, 10_000]
/** How long a window may stay unresponsive before Namzu ends its process. */
export const HANG_GRACE_MS = 20_000

/** Chromium's code for a load that was cancelled by a newer one; not a failure. */
const ABORTED = -3

export interface RecoveryTimers {
	now(): number
	/** Runs `run` after `ms`; the returned function cancels it. */
	after(ms: number, run: () => void): () => void
}

export interface WindowRecoveryDeps {
	timers: RecoveryTimers
	/** Loads the app's page again. */
	reload(): void
	/** Puts the recovery card in the window. */
	showCard(cause: RecoveryCause): void
	/** Ends a window process that stopped answering. */
	endProcess(): void
	/** The window no longer exists; nothing is reloaded for it. */
	closed(): boolean
}

/**
 * What one window does when its page crashes, hangs or fails to load. A crash or a hang is
 * answered with a reload after a short, growing wait, at most three times a minute: a window that
 * keeps dying gets an honest card with a Reload link instead of a loop. A hang is given a grace
 * period (a long synchronous job is not a hang) before its process is ended. A page that fails to
 * load gets the card at once, because loading it again unchanged would fail the same way.
 */
export class WindowRecovery {
	private reloads: number[] = []
	private cancelReload: (() => void) | undefined
	private cancelHang: (() => void) | undefined
	private hangEnded = false
	private card = false

	constructor(private readonly deps: WindowRecoveryDeps) {}

	/** The card is on screen and the Reload link is live. */
	get cardShowing(): boolean {
		return this.card
	}

	processGone(reason: string, exitCode: number): void {
		// A window closing or the app quitting is not a failure.
		if (reason === 'clean-exit') return
		this.clearHang()
		const hung = this.hangEnded
		this.hangEnded = false
		this.recover((reloads) =>
			hung ? { kind: 'hung', reloads } : { kind: 'crashed', reason, exitCode, reloads },
		)
	}

	unresponsive(): void {
		if (this.cancelHang || this.card || this.deps.closed()) return
		this.cancelHang = this.deps.timers.after(HANG_GRACE_MS, () => {
			this.cancelHang = undefined
			if (this.deps.closed()) return
			this.hangEnded = true
			try {
				this.deps.endProcess()
			} catch {
				// Nothing left to end: go straight to the reload the ended process would have caused.
				this.processGone('crashed', 0)
			}
		})
	}

	responsive(): void {
		this.clearHang()
	}

	loadFailed(errorCode: number): void {
		if (errorCode === ABORTED || this.deps.closed()) return
		this.clearReload()
		this.clearHang()
		this.card = true
		this.deps.showCard({ kind: 'load-failed', errorCode })
	}

	/** The person asked: the count starts again, so Reload always tries. */
	manualReload(): void {
		if (this.deps.closed()) return
		this.reloads = []
		this.clearReload()
		this.card = false
		this.deps.reload()
	}

	/** True when `url` is the card's Reload link, which is acted on only while the card shows. */
	navigation(url: string): boolean {
		if (url !== RECOVERY_RELOAD_URL) return false
		if (this.card) this.manualReload()
		return true
	}

	dispose(): void {
		this.clearReload()
		this.clearHang()
	}

	private recover(cause: (reloads: number) => RecoveryCause): void {
		if (this.deps.closed()) return
		const now = this.deps.timers.now()
		this.reloads = this.reloads.filter((at) => now - at < RELOAD_WINDOW_MS)
		this.clearReload()
		if (this.reloads.length >= MAX_AUTOMATIC_RELOADS) {
			this.card = true
			this.deps.showCard(cause(this.reloads.length))
			return
		}
		const wait = RELOAD_DELAYS_MS[this.reloads.length] ?? RELOAD_DELAYS_MS.at(-1) ?? 0
		this.reloads.push(now)
		this.card = false
		this.cancelReload = this.deps.timers.after(wait, () => {
			this.cancelReload = undefined
			if (!this.deps.closed()) this.deps.reload()
		})
	}

	private clearReload(): void {
		this.cancelReload?.()
		this.cancelReload = undefined
	}

	private clearHang(): void {
		this.cancelHang?.()
		this.cancelHang = undefined
	}
}
