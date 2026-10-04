export interface WorkspaceSessionTicket {
	readonly sessionId: string
	readonly projectId: string
	readonly membership: number
	readonly connection: number
}

/** Only fully admitted sessions in this pane may reuse their live renderer state. */
export class WorkspaceSessionCache<T> {
	private members = new Set<string>()
	private readonly memberships = new Map<string, number>()
	private readonly connections = new Map<string, number>()
	private readonly admitted = new Map<string, { ticket: WorkspaceSessionTicket; value: T }>()
	private readonly mutations = new Map<
		string,
		{ count: number; settled: Promise<void>; resolve: () => void }
	>()

	synchronizeMembers(ids: readonly string[]): void {
		const next = new Set(ids)
		for (const id of this.members) if (!next.has(id)) this.forget(id)
		this.members = next
	}

	ticket(sessionId: string, projectId: string): WorkspaceSessionTicket {
		return {
			sessionId,
			projectId,
			membership: this.memberships.get(sessionId) ?? 0,
			connection: this.connections.get(projectId) ?? 0,
		}
	}

	current(ticket: WorkspaceSessionTicket): boolean {
		return (
			this.members.has(ticket.sessionId) &&
			!this.mutations.has(ticket.sessionId) &&
			ticket.membership === (this.memberships.get(ticket.sessionId) ?? 0) &&
			ticket.connection === (this.connections.get(ticket.projectId) ?? 0)
		)
	}

	remember(ticket: WorkspaceSessionTicket, value: T): boolean {
		if (!this.current(ticket)) return false
		this.admitted.set(ticket.sessionId, { ticket, value })
		return true
	}

	read(sessionId: string, projectId: string): T | undefined {
		const saved = this.admitted.get(sessionId)
		return saved?.ticket.projectId === projectId && this.current(saved.ticket)
			? saved.value
			: undefined
	}

	forget(sessionId: string): void {
		this.memberships.set(sessionId, (this.memberships.get(sessionId) ?? 0) + 1)
		this.admitted.delete(sessionId)
	}

	/** Choice changes retire old admission before and after their asynchronous ACK. */
	beginMutation(sessionId: string): () => void {
		this.forget(sessionId)
		let mutation = this.mutations.get(sessionId)
		if (!mutation) {
			let resolve!: () => void
			const settled = new Promise<void>((done) => {
				resolve = done
			})
			mutation = { count: 0, settled, resolve }
			this.mutations.set(sessionId, mutation)
		}
		mutation.count++
		const pending = mutation
		let finished = false
		return () => {
			if (finished) return
			finished = true
			this.forget(sessionId)
			if (--pending.count !== 0) return
			this.mutations.delete(sessionId)
			pending.resolve()
		}
	}

	mutating(sessionId: string): boolean {
		return this.mutations.has(sessionId)
	}

	async whenSettled(sessionId: string): Promise<void> {
		let mutation = this.mutations.get(sessionId)
		while (mutation) {
			await mutation.settled
			mutation = this.mutations.get(sessionId)
		}
	}

	invalidateProject(projectId: string): void {
		this.connections.set(projectId, (this.connections.get(projectId) ?? 0) + 1)
		for (const [id, saved] of this.admitted)
			if (saved.ticket.projectId === projectId) this.admitted.delete(id)
	}
}
