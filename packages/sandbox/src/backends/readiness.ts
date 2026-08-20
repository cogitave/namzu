/**
 * One owner for backend readiness clocks.
 *
 * A timestamp checked between retries is not a deadline when the thing inside
 * a retry can remain pending. This owner races every foreign promise against
 * the remaining operation budget and supplies a private signal so cooperative
 * transports can release their sockets too.
 */

const MAX_NODE_TIMER_MS = 2_147_483_647

/**
 * Readiness failure teardown is deliberately a second, short budget. The
 * health deadline has already expired, so pretending cleanup fits inside it
 * either skips cleanup entirely or keeps `create()` pending without a bound.
 */
export const FAILURE_CLEANUP_GRACE_MS = 1_000

export interface ReadinessOptions {
	readonly timeoutMs: number
	readonly pollIntervalMs: number
}

export class OperationDeadlineExpired extends Error {
	constructor(readonly label: string) {
		super(`${label} deadline expired`)
		this.name = 'OperationDeadlineExpired'
	}
}

function assertTimerValue(field: string, value: number): void {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_NODE_TIMER_MS) {
		throw new RangeError(
			`${field} must be a positive safe integer no greater than ${MAX_NODE_TIMER_MS}; received ${String(value)}`,
		)
	}
}

export function resolveReadinessOptions(
	owner: string,
	timeoutMs: number | undefined,
	pollIntervalMs: number | undefined,
	defaults: ReadinessOptions,
): ReadinessOptions {
	const resolved = {
		timeoutMs: timeoutMs ?? defaults.timeoutMs,
		pollIntervalMs: pollIntervalMs ?? defaults.pollIntervalMs,
	}
	assertTimerValue(`${owner}.readyTimeoutMs`, resolved.timeoutMs)
	assertTimerValue(`${owner}.readyPollIntervalMs`, resolved.pollIntervalMs)
	return resolved
}

export class OperationDeadline {
	private readonly expiresAt: number

	constructor(
		timeoutMs: number,
		readonly label: string,
	) {
		assertTimerValue(`${label} timeout`, timeoutMs)
		this.expiresAt = performance.now() + timeoutMs
	}

	remainingMs(): number {
		return Math.max(0, this.expiresAt - performance.now())
	}

	async run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const remaining = this.remainingMs()
		if (remaining <= 0) throw new OperationDeadlineExpired(this.label)

		const controller = new AbortController()
		const expired = new OperationDeadlineExpired(this.label)
		let timer: ReturnType<typeof setTimeout> | undefined
		const expiry = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				controller.abort(expired)
				reject(expired)
			}, remaining)
		})
		const pending = Promise.resolve().then(() => operation(controller.signal))

		try {
			const value = await Promise.race([pending, expiry])
			// Publication fence: a foreign promise that settles at the boundary
			// does not get to turn an already-expired attempt into readiness.
			if (controller.signal.aborted || this.remainingMs() <= 0) {
				controller.abort(expired)
				throw expired
			}
			return value
		} finally {
			if (timer !== undefined) clearTimeout(timer)
		}
	}

	async delay(maximumMs: number): Promise<void> {
		await this.run(
			(signal) =>
				new Promise<void>((resolve, reject) => {
					if (signal.aborted) {
						reject(signal.reason)
						return
					}
					const finish = (err?: unknown) => {
						clearTimeout(timer)
						signal.removeEventListener('abort', abort)
						if (err === undefined) resolve()
						else reject(err)
					}
					const abort = () => {
						finish(signal.reason)
					}
					const timer = setTimeout(() => finish(), maximumMs)
					signal.addEventListener('abort', abort, { once: true })
				}),
		)
	}
}

export async function probeHttpHealth(
	url: string,
	signal: AbortSignal,
): Promise<{ readonly ok: boolean; readonly status: number }> {
	signal.throwIfAborted()
	const response = await fetch(url, { signal })
	const result = { ok: response.ok, status: response.status }
	try {
		await response.body?.cancel()
	} catch {
		// The status is already known. A body cancellation failure must not
		// hide it; the owning deadline still aborts the transport if needed.
	}
	signal.throwIfAborted()
	return result
}

/**
 * Failure cleanup must never replace or indefinitely delay the primary
 * readiness error. Cooperative cleanup observes the signal; an implementation
 * that ignores it is still detached from the caller by the independent race.
 */
export async function runFailureCleanup(
	cleanup: (signal: AbortSignal) => Promise<void>,
	graceMs = FAILURE_CLEANUP_GRACE_MS,
): Promise<void> {
	const deadline = new OperationDeadline(graceMs, 'sandbox failure cleanup')
	try {
		await deadline.run(cleanup)
	} catch {
		// The readiness failure remains primary. Promise.race installed a
		// rejection observer on the losing cleanup promise, so a late failure
		// cannot become an unhandled rejection.
	}
}
