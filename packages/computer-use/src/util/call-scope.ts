import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * A request was cancelled by its caller. `sent` tells whether it had been
 * written to the desktop driver: when it had, the driver may still act on it,
 * and the caller must not assume it did not.
 */
export class CallAbortedError extends Error {
	override readonly name = 'CallAbortedError'

	constructor(
		readonly method: string,
		readonly sent: boolean,
	) {
		super(
			sent
				? `${method} was cancelled after it was sent; the driver may still have acted on it.`
				: `${method} was cancelled before it was sent.`,
		)
	}
}

/** What the tool call being served shares with every driver call made for it. */
export interface CallScope {
	readonly signal: AbortSignal | undefined
	/** Something that changes the desktop was sent for this call (or may have been). */
	sent: boolean
}

const scope = new AsyncLocalStorage<CallScope>()

/**
 * Runs `run` as one tool call. Its `signal` reaches every driver call and
 * foreground burst made on its behalf without each internal helper taking a
 * parameter, and the scope records whether anything was sent.
 */
export function inCallScope<T>(
	signal: AbortSignal | undefined,
	run: (scope: CallScope) => Promise<T>,
): Promise<T> {
	const own: CallScope = { signal, sent: false }
	return scope.run(own, () => run(own))
}

/** The signal of the call being served, when it has one. */
export function currentCallSignal(): AbortSignal | undefined {
	return scope.getStore()?.signal
}

/** Records that the call being served sent (or may have sent) something that changes the desktop. */
export function markSent(): void {
	const own = scope.getStore()
	if (own) own.sent = true
}
