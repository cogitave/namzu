import { createHash } from 'node:crypto'

/**
 * A short, stable fingerprint of a file body.
 *
 * Used to answer one question at mutation time: is the file still what the
 * agent read? An `edit` is computed against a remembered body, and between
 * the read and the write that body can move — a person editing in an
 * editor, another process, a second agent run. The in-process mutation lock
 * serializes this runtime's own writers and is blind to every one of those.
 *
 * Without this the drift is not merely undetected, it is actively
 * misreported: an `old_string` that no longer matches comes back as "not
 * found in file — make sure the string matches exactly", which tells the
 * agent its input was wrong when the file changed underneath it. The agent
 * then retries the same edit against the same moved file.
 *
 * Truncated deliberately. This distinguishes two bodies; it is not a
 * security boundary, and a full digest per read costs bytes in a structure
 * that lives for the whole run.
 */
export function fingerprintContent(content: string): string {
	return createHash('sha256').update(content, 'utf-8').digest('hex').slice(0, 16)
}

/** What a mutation tool tells the agent when the file moved under it. */
export function staleFileError(path: string): string {
	return (
		`${path} changed on disk after you read it, so this edit was computed against a stale copy ` +
		'and was not applied. Read the file again and redo the edit against its current contents. ' +
		'Nothing was written.'
	)
}
