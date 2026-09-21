import type { SessionIndex } from '../../store/session-index/index.js'
import type { SessionLease, SessionLog } from '../../store/session-log/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'

/** How a session-level operation finds the session's log. */
export interface SessionLocatorOptions {
	/** Use this log directly. */
	readonly log?: SessionLog
	/** Otherwise resolve the log through this index. */
	readonly index?: SessionIndex
	/** Otherwise open the index under this home. Defaults to `resolveNamzuHome()`. */
	readonly home?: string
	/** A lease the caller already holds. Absent: the lease is claimed and released around the append. */
	readonly lease?: SessionLease
}

/**
 * Close a session's active turn without resuming it: appends
 * `turn_failed{ error.code: 'abandoned', reason }` and frees the session for
 * its next turn. The only other way out of a paused turn is `resumeSession`.
 */
export async function abandonTurn(
	_sessionId: SessionId,
	_turnId: TurnId,
	_reason: string,
	_options?: SessionLocatorOptions,
): Promise<void> {
	throw new Error('train: not yet wired')
}
