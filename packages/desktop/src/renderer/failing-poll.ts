/** Reads in a row that may fail before a repeating read stops and waits for a reason to start again. */
export const POLL_FAILURE_LIMIT = 4
/** A failing read is never asked less often than this before it stops. */
export const POLL_FAILURE_CEILING_MS = 60_000

/**
 * The wait before a repeating read asks again. A read that works keeps its own pace; each failure
 * in a row doubles the wait; after `POLL_FAILURE_LIMIT` failures there is no next read (null), so a
 * call that cannot succeed is never repeated for ever. The owner starts it again on a reason the
 * person can see: the connection came back, a manual refresh, the window was brought back.
 */
export function pollDelay(baseMs: number, failures: number): number | null {
	if (failures <= 0) return baseMs
	if (failures >= POLL_FAILURE_LIMIT) return null
	return Math.min(POLL_FAILURE_CEILING_MS, baseMs * 2 ** failures)
}

/**
 * A repeating read that slows after each failure and gives up after `POLL_FAILURE_LIMIT` in a row.
 * `read` answers true when it worked. The owner starts a poll that gave up with `resume` (the
 * connection came back, the window was focused) and `stopped` says when that is needed.
 */
export function createFailingPoll(options: {
	baseMs: number
	read: () => Promise<boolean>
	setTimer?: (run: () => void, ms: number) => unknown
	clearTimer?: (timer: unknown) => void
}) {
	const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
	const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number))
	let failures = 0
	let timer: unknown
	let over = false
	const poll = {
		/** Reads once, outside the schedule (a person's refresh), and counts the result. */
		async run(): Promise<boolean> {
			const ok = await options.read()
			if (!over) failures = ok ? 0 : failures + 1
			return ok
		},
		/** Plans the next read; nothing when the poll gave up, is over, or already has one planned. */
		schedule(): void {
			const delay = pollDelay(options.baseMs, failures)
			if (over || delay === null || timer !== undefined) return
			timer = setTimer(() => {
				timer = undefined
				void poll.run().then(poll.schedule)
			}, delay)
		},
		/** Reads now, then keeps going on the schedule. */
		start(): void {
			void poll.run().then(poll.schedule)
		},
		/** A reason the person can see to try again: forget the failures and read now. */
		resume(): void {
			failures = 0
			poll.start()
		},
		/** The poll gave up: no read is planned and the failures are at the limit. */
		get stopped(): boolean {
			return !over && timer === undefined && pollDelay(options.baseMs, failures) === null
		},
		get failures(): number {
			return failures
		},
		stop(): void {
			over = true
			if (timer !== undefined) clearTimer(timer)
			timer = undefined
		},
	}
	return poll
}
