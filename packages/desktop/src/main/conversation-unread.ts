/**
 * Which conversations have a finished turn the person has not looked at yet.
 *
 * Main is the only owner: every window shows what this holds, so two windows can never disagree
 * about a marker or each clear it. A turn that ends while some window is showing that conversation
 * leaves no marker; one that ends elsewhere sets it, and showing the conversation clears it once.
 * `sequence` counts changes, so a window can tell an answer that arrived late from a newer event.
 */
export class ConversationUnread {
	private readonly held = new Set<string>()
	private counter = 0
	constructor(
		initial: Iterable<string> = [],
		private readonly limit = 1024,
	) {
		for (const id of initial) if (valid(id) && this.held.size < limit) this.held.add(id)
	}
	get sequence(): number {
		return this.counter
	}
	ids(): string[] {
		return [...this.held]
	}
	has(id: string): boolean {
		return this.held.has(id)
	}
	/** A turn ended. Returns whether the set changed. */
	turnEnded(id: string, viewed: ReadonlySet<string>): boolean {
		if (viewed.has(id)) return false
		return this.set(id, true)
	}
	/** Marks one conversation unread or read. Returns whether the set changed. */
	set(id: string, unread: boolean): boolean {
		if (!valid(id)) throw new Error('Invalid conversation.')
		if (unread) {
			if (this.held.has(id)) return false
			if (this.held.size >= this.limit) throw new Error('Too many conversations are marked unread.')
			this.held.add(id)
		} else if (!this.held.delete(id)) return false
		this.counter++
		return true
	}
	/** Clears every marker whose conversation is on screen now. Returns the ones it cleared. */
	reconcile(viewed: ReadonlySet<string>): string[] {
		const cleared = [...this.held].filter((id) => viewed.has(id))
		for (const id of cleared) this.held.delete(id)
		if (cleared.length > 0) this.counter++
		return cleared
	}
	/** A conversation that no longer exists keeps no marker. */
	forget(ids: Iterable<string>): boolean {
		let changed = false
		for (const id of ids) if (this.held.delete(id)) changed = true
		if (changed) this.counter++
		return changed
	}
}

function valid(id: unknown): id is string {
	return (
		typeof id === 'string' &&
		id.trim().length > 0 &&
		id.length <= 400 &&
		!Array.from(id).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
	)
}
