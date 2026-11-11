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
