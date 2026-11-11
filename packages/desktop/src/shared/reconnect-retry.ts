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

	/** True when no read is waiting and none is spent, so the record can be dropped. */
	get empty(): boolean {
		return this.waiting.size === 0 && this.spent.size === 0
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

/** One `ReconnectRetry` per project, dropped when the project or one of its reads goes away. */
export class ReconnectRetries {
	private readonly groups = new Map<string, ReconnectRetry>()

	/** A read of the project failed; see `ReconnectRetry.failed`. */
	failed(projectId: string, key: string, retry: () => void): boolean {
		let group = this.groups.get(projectId)
		if (!group) {
			group = new ReconnectRetry()
			this.groups.set(projectId, group)
		}
		return group.failed(key, retry)
	}

	/** A read of the project worked. */
	succeeded(projectId: string, key: string): void {
		this.forget(projectId, key)
	}

	/** The project's connection came back. */
	reconnected(projectId: string): void {
		this.groups.get(projectId)?.reconnected()
	}

	/** A read is no longer wanted (its conversation closed). */
	forget(projectId: string, key: string): void {
		const group = this.groups.get(projectId)
		if (!group) return
		group.forget(key)
		if (group.empty) this.groups.delete(projectId)
	}

	/** The project is gone: nothing of it is asked again, and nothing of it is kept. */
	drop(projectId: string): void {
		this.groups.delete(projectId)
	}

	get size(): number {
		return this.groups.size
	}
}
