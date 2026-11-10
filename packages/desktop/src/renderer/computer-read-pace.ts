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
}): number {
	const base = state.ready && state.watching ? WATCHING_READ_MS : IDLE_READ_MS
	if (state.failures <= 0) return base
	return Math.min(FAILING_READ_MS, IDLE_READ_MS * 2 ** Math.min(state.failures, 10))
}
