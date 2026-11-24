/**
 * What a screen reads about a team, as plain data: who is on it, what each member is doing, and the
 * team's task list. Built by the sub-agent runtime from the runner's states and the shared task list;
 * the terminal and the desktop only draw it.
 */

/** `working`: a turn is running; `waiting`: it asked the person and waits; `idle`: between pieces of work; `stopped`: ended for good. */
export type TeamMemberState = 'working' | 'idle' | 'waiting' | 'stopped'

export interface TeamMemberView {
	readonly name: string
	/** The row this member has in the agent list, so a screen can open its transcript. */
	readonly viewId: string
	readonly state: TeamMemberState
	/** When it went idle or was stopped (ms since the epoch); 0 while it works. */
	readonly since: number
}

export interface TeamTaskView {
	readonly id: string
	readonly subject: string
	readonly status: 'pending' | 'in_progress' | 'completed' | 'failed'
	readonly owner?: string
	readonly blockedBy: readonly string[]
	/** When it was completed (ms since the epoch), once it was. */
	readonly completedAt?: number
}

/** Read-only side of the session's team. */
export interface TeamViewSource {
	/** The team's name, once the first teammate has started. */
	team(): string | undefined
	/** The members now, oldest first. A member that left the team is not listed. */
	members(): readonly TeamMemberView[]
	/** The name of the teammate behind this agent view when it approved a shutdown and left the team. */
	left?(viewId: string): string | undefined
	/** Every task on the team's list. */
	tasks(): Promise<readonly TeamTaskView[]>
	/** Hear a change of members, asks or tasks; one call, no detail. */
	subscribe(listener: () => void): () => void
}
