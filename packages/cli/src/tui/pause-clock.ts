/**
 * Time spent waiting for the person: a permission or a question answered by
 * hand. A turn's "Worked for" line leaves it out, because the agent was not
 * working while it waited. Pure; the clock is passed in.
 */
export class PauseClock {
	#total = 0
	#since: number | null = null

	/** The person is now being waited on. A second call while waiting changes nothing. */
	begin(now: number): void {
		if (this.#since === null) this.#since = now
	}

	/** The wait is over. */
	end(now: number): void {
		if (this.#since === null) return
		this.#total += Math.max(0, now - this.#since)
		this.#since = null
	}

	/** Milliseconds waited so far, counting a wait that is still open. */
	total(now: number): number {
		return this.#total + (this.#since === null ? 0 : Math.max(0, now - this.#since))
	}
}
