import type { MailEntry, TeamBackendKind, TeamMember } from './types.js'

/**
 * Where teammates run. The in-process backend (a long-lived child session inside the lead's process)
 * is the first; a separate-process or pane backend plugs in later behind the same four calls, so the
 * rest of a team (names, mailboxes, the shared task list) does not change.
 *
 * @experimental
 */
export interface TeammateStartSpec {
	readonly team: string
	/** The reserved member: its name and id are already in the team's `config.json`. */
	readonly member: TeamMember
	/** The first thing the teammate is told. The lead's conversation is not carried over. */
	readonly prompt: string
	readonly cwd?: string
	readonly model?: string
}

export interface TeammateBackend {
	readonly kind: TeamBackendKind
	/** Start the teammate. A rejection means nothing runs and the reservation is rolled back. */
	start(spec: TeammateStartSpec): Promise<void>
	/** Deliver mail to a running teammate now; the mailbox file is the record either way. */
	send(team: string, name: string, mail: MailEntry): Promise<void>
	/** End the teammate. */
	stop(team: string, name: string, reason?: string): Promise<void>
	isAlive(team: string, name: string): boolean
}
