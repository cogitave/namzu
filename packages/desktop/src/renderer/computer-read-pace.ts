/** How often the Pal's computer is read: fast while its screen is the page, slow otherwise. */
export const WATCHING_READ_MS = 1_000
export const IDLE_READ_MS = 5_000
/** A read that keeps failing is retried less and less often, never slower than this. */
export const FAILING_READ_MS = 60_000

/**
 * The wait before the next read of the Pal's computer. A run of failed reads (the status call or
 * the screen capture threw) doubles the wait each time, so a broken computer is not asked every
 * five seconds for an hour; any read that works returns to the normal pace.
 */
export function nextComputerReadDelay(state: {
	ready: boolean
	watching: boolean
	failures: number
	/**
	 * The computer said it is not set up. Time does not fix that, so there is no next read: the loop
	 * stops until the person starts setup, comes back to the window or the setup state changes.
	 */
	parked?: boolean
}): number | null {
	if (state.parked) return null
	const base = state.ready && state.watching ? WATCHING_READ_MS : IDLE_READ_MS
	if (state.failures <= 0) return base
	return Math.min(FAILING_READ_MS, IDLE_READ_MS * 2 ** Math.min(state.failures, 10))
}

/** What one read of the Pal's computer found, for the scheduler that decides about the next. */
export interface ComputerReadOutcome {
	ready: boolean
	watching: boolean
	/** The read threw, or the computer answered "unavailable" for a reason that can pass. */
	failed: boolean
	/** The read got an answer (a skipped read, hidden window or pending control, did not). */
	answered: boolean
	/** The computer said it is not set up. */
	parked: boolean
}

/**
 * Chains the reads of one Pal's computer. `settle` is called when a read ends: it schedules the
 * next one after `nextComputerReadDelay`, or schedules nothing when the computer is not set up.
 * The owner builds a new scheduler to start again (a click on Start, a finished setup, the window
 * coming back), which is the only way a parked computer is read again.
 */
export function createComputerReadScheduler(options: {
	run: () => void
	setTimer?: (run: () => void, ms: number) => unknown
	clearTimer?: (timer: unknown) => void
}) {
	const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number))
	let failures = 0
	let timer: unknown
	let stopped = false
	let parked = false
	return {
		get parked() {
			return parked
		},
		settle(outcome: ComputerReadOutcome): void {
			if (stopped) return
			failures = outcome.failed ? failures + 1 : outcome.answered ? 0 : failures
			const delay = nextComputerReadDelay({
				ready: outcome.ready,
				watching: outcome.watching,
				failures,
				parked: outcome.parked,
			})
			parked = delay === null
			if (delay !== null) timer = setTimer(options.run, delay)
		},
		stop(): void {
			stopped = true
			if (timer !== undefined) clearTimer(timer)
			timer = undefined
		},
	}
}
