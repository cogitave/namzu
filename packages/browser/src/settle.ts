/**
 * Waiting for a page to go quiet, as a small state machine over an injected
 * clock and probe so that its timing can be tested without waiting.
 *
 * A page is quiet when nothing in it has changed and no request is in flight
 * for `quietMs`. The wait is capped: a page that animates or polls forever is
 * never quiet, and the caller reports that instead of waiting on it.
 */

/** Time, as the host or a test supplies it. */
export interface SettleClock {
	now(): number
	sleep(ms: number): Promise<void>
}

/** How long the page has been still, in milliseconds; 0 while a request is in flight. */
export interface SettleProbe {
	stillForMs(): Promise<number>
}

export interface SettleOptions {
	/** How long the page must be still. */
	readonly quietMs: number
	/** The longest the whole wait may take. */
	readonly capMs: number
	/** How often the probe is read. Default: a fifth of `quietMs`, at least 20. */
	readonly pollMs?: number
}

export interface SettleOutcome {
	/** The page went quiet before the cap. */
	readonly quiet: boolean
	/** How long the wait took. */
	readonly waitedMs: number
	readonly capMs: number
}

/**
 * Wait until `probe` has reported `quietMs` of stillness, or `capMs` has
 * passed. The stillness is never counted from before the wait began, so an
 * event that is still on its way to the host (a popup, a request the browser
 * has not announced yet) has `quietMs` to arrive.
 */
export async function waitUntilQuiet(
	clock: SettleClock,
	probe: SettleProbe,
	options: SettleOptions,
): Promise<SettleOutcome> {
	const { quietMs, capMs } = options
	const poll = Math.max(20, options.pollMs ?? Math.floor(quietMs / 5))
	const start = clock.now()
	for (;;) {
		const elapsed = clock.now() - start
		const still = Math.min(await probe.stillForMs(), clock.now() - start)
		if (still >= quietMs) return { quiet: true, waitedMs: clock.now() - start, capMs }
		if (elapsed >= capMs) return { quiet: false, waitedMs: clock.now() - start, capMs }
		const remainingToQuiet = Math.max(1, quietMs - still)
		await clock.sleep(Math.min(poll, remainingToQuiet, Math.max(1, capMs - elapsed)))
	}
}
