/**
 * A conversation whose reply belongs to another window.
 *
 * A turn holds its conversation under a lease that names the process running
 * it. When that process is gone the lease is not given back; it lapses on its
 * own after a few minutes. Until then a message sent from here is refused as
 * "a reply is still running", and the advice that fits a reply of this window
 * (stop it with Esc) does nothing, because the reply is not this window's.
 */

import { type SessionLease, currentPlace, parseTurnHolder } from '@namzu/sdk'

/**
 * Whether a turn's lease holder (`namzu:<pid>:<turn>@<place>`) names this very process: the same
 * process id, and, when the holder says where it was issued, the same place. A holder with no
 * place (an older version) is read by its process id alone, as it always was.
 */
function isOwnHolder(holder: string, ownProcess: number, place: string): boolean {
	const parsed = parseTurnHolder(holder)
	if (!parsed || parsed.pid !== ownProcess) return false
	return parsed.place === undefined || parsed.place === place
}

/**
 * Whole minutes (at least one, rounded up) until the lease of another process
 * lapses, or `undefined` when the lease is gone, lapsed, or this process's own.
 */
export function minutesUntilFree(
	lease: Pick<SessionLease, 'holder' | 'expiresAt'> | null | undefined,
	now: number,
	ownProcess: number = process.pid,
	place: string = currentPlace(),
): number | undefined {
	if (!lease || lease.expiresAt <= now) return undefined
	if (isOwnHolder(lease.holder, ownProcess, place)) return undefined
	return Math.max(1, Math.ceil((lease.expiresAt - now) / 60_000))
}

/** What the person is told: where the reply is, and when the conversation is theirs again. */
export function conversationInUseSentence(minutes: number): string {
	return `This conversation is in use by another window. It is available again in about ${
		minutes === 1 ? '1 minute' : `${minutes} minutes`
	}.`
}
