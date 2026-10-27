import { createHash } from 'node:crypto'

/**
 * A short, stable fingerprint of a file body.
 *
 * Used to answer one question at mutation admission: is the file still what
 * the agent read? An `edit` or full replacement is based on a remembered
 * body, and before the write begins that body can move — a person editing in
 * an editor, another process, a second agent's turn. The in-process mutation
 * lock serializes this runtime's own writers and is blind to every one of
 * those.
 *
 * Without this the drift is not merely undetected, it is actively
 * misreported: an `old_string` that no longer matches comes back as "not
 * found in file — make sure the string matches exactly", which tells the
 * agent its input was wrong when the file changed underneath it. The agent
 * then retries the same edit against the same moved file.
 *
 * Truncated deliberately. This distinguishes two bodies; it is not a
 * security boundary, and a full digest per read costs bytes in a structure
 * that lives for the whole turn.
 */
export function fingerprintContent(content: string): string {
	return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16)
}

/** What a mutation tool tells the agent when admission sees a moved file. */
export function staleFileError(path: string, operation: 'edit' | 'write' = 'edit'): string {
	return `${path} changed on disk after you read it, so this ${operation} was based on a stale copy and was not applied. Read the file again and redo the ${operation} against its current contents. Nothing was written.`
}

/** What a mutation tool tells the agent when the session never read the file. */
export function unreadFileError(path: string, operation: 'edit' | 'write' = 'edit'): string {
	return `${path} has not been read yet. Read it first, then redo the ${operation}. Nothing was written.`
}

/**
 * Whether the file at `key` has moved on disk since the session read it.
 *
 * The read side of the same comparison `edit` and `write` make when they run,
 * for asking before a reviewer is: `current` is the body now on disk. False
 * when the host keeps no ledger, never read the path (a different refusal, and
 * a read earlier in the same batch may still satisfy it), or cannot fingerprint.
 */
export function movedSinceRead(
	tracker:
		| { hasRead(key: string): boolean; fingerprint?(key: string): string | undefined }
		| undefined,
	key: string,
	current: string,
): boolean {
	if (!tracker || !tracker.hasRead(key)) return false
	const seen = tracker.fingerprint?.(key)
	return seen !== undefined && seen !== fingerprintContent(current)
}
