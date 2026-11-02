/**
 * A bound on how many times in a row a session wakes the model on its own.
 *
 * A finished background job wakes an idle session, and the turn that wakes may
 * start another job whose exit wakes it again, with nobody reading. For an
 * owner that nobody is watching, that chain never has to end. The budget caps
 * it: after `max` wakes in a row no further exit wakes the model, and the
 * exits stay pending so the next message from a person carries them.
 *
 * **Off unless asked.** An interactive session has a person to stop it, and a
 * cap there would only get in the way. `max` of `undefined` (or anything that
 * is not a positive integer) never limits.
 *
 * **Only a person resets it.** A wake, a job notice or a tool result is not
 * evidence anyone is looking; a human message is.
 */
export class WakeBudget {
	private woken = 0
	private readonly max: number | undefined

	constructor(max?: number) {
		this.max = max !== undefined && Number.isInteger(max) && max > 0 ? max : undefined
	}

	/** Whether another automatic wake is allowed. */
	get canWake(): boolean {
		return this.max === undefined || this.woken < this.max
	}

	/** Count one automatic wake. Call when a wake begins a turn. */
	recordWake(): void {
		this.woken++
	}

	/** A person wrote: the chain is attended again. */
	reset(): void {
		this.woken = 0
	}

	/** Wakes since the last human message. */
	get consecutiveWakes(): number {
		return this.woken
	}
}

/**
 * The budget a host asked for through `NAMZU_MAX_CONSECUTIVE_WAKES`, or an
 * unlimited one. Anything but a positive integer means no limit.
 */
export function wakeBudgetFromEnv(
	env: Record<string, string | undefined> = process.env,
): WakeBudget {
	const raw = env.NAMZU_MAX_CONSECUTIVE_WAKES?.trim()
	return new WakeBudget(raw && /^\d+$/.test(raw) ? Number(raw) : undefined)
}
