/**
 * A read that fails once is asked again once, the next time the connection comes back, and not on
 * a timer. A second failure of the same read is left to the person (a Try again button), so a
 * broken read can never turn into a loop. A read that works clears its record.
 */
export class ReconnectRetry {
	private readonly waiting = new Map<string, () => void>()
	private readonly spent = new Set<string>()

	/** A read failed. True when it will be asked again at the next reconnect; false when it already was. */
	failed(key: string, retry: () => void): boolean {
		if (this.spent.has(key)) return false
		this.spent.add(key)
		this.waiting.set(key, retry)
		return true
	}

	/** The read worked: a later failure of it earns its one retry again. */
	succeeded(key: string): void {
		this.spent.delete(key)
		this.waiting.delete(key)
	}

	/** The read is no longer wanted (the conversation closed). */
	forget(key: string): void {
		this.succeeded(key)
	}

	/** The connection came back: every waiting read is asked once. */
	reconnected(): void {
		const retries = [...this.waiting.values()]
		this.waiting.clear()
		for (const retry of retries) retry()
	}
}
