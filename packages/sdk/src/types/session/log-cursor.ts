/**
 * Where a reconnecting consumer left off in a session log, and whether the
 * kernel can honour it.
 *
 * The shortfall is a VALUE here, not a sentence in a document. A consumer that
 * asks for everything after seq 400 and silently receives a splice from a
 * different generation of the log is wrong and has no way to find out; a
 * consumer handed `{ status: 'unavailable', reason: 'cursor_ahead' }` re-derives
 * from the log and is right.
 */

import type { SessionLogHead } from '../../store/session-log/index.js'
import type { FencingToken } from './durable.js'
import type { SessionRecord } from './records.js'

/** What a consumer holds when it comes back. */
export interface SessionLogCursor {
	/** The last record `seq` the consumer received. Zero means "from the beginning". */
	readonly sinceSeq: number
	/**
	 * The lease fence (`gen`) of the records the consumer received, when it
	 * tracked one. Compared for equality only.
	 */
	readonly generation?: FencingToken
}

/** Why a cursor could not be honoured. */
export type SessionLogReplayRefusal =
	/** The consumer claims to have seen more than the log holds. */
	| 'cursor_ahead'
	/** The session has been taken over since; the consumer's position belongs to an older holding. */
	| 'generation_changed'
	/** The first record returned is not the one right after the cursor. */
	| 'gap'

/** What came of a cursor. */
export type SessionLogReplay =
	/** The cursor is already at the log's head. Nothing was missed. */
	| { readonly status: 'complete' }
	/** Contiguous from `sinceSeq + 1`, oldest first. */
	| { readonly status: 'replayed'; readonly records: readonly SessionRecord[] }
	/** Nothing is delivered. The consumer re-derives from the log. */
	| { readonly status: 'unavailable'; readonly reason: SessionLogReplayRefusal }

/**
 * Decide what a cursor is owed, given the log's head and the records read
 * after `cursor.sinceSeq`.
 *
 * Pure. The generation check runs FIRST: a takeover invalidates the position,
 * so comparing sequences across generations would be arithmetic on two
 * different scales. A `null` head is an empty log.
 */
export function resolveSessionLogReplay(
	cursor: SessionLogCursor,
	head: SessionLogHead | null,
	records: readonly SessionRecord[],
): SessionLogReplay {
	const lastSeq = head?.pointer.seq ?? 0
	if (cursor.generation !== undefined && head !== null && cursor.generation !== head.gen) {
		return { status: 'unavailable', reason: 'generation_changed' }
	}
	if (cursor.sinceSeq > lastSeq) return { status: 'unavailable', reason: 'cursor_ahead' }
	if (cursor.sinceSeq === lastSeq) return { status: 'complete' }
	const first = records[0]
	if (!first || first.seq !== cursor.sinceSeq + 1) {
		return { status: 'unavailable', reason: 'gap' }
	}
	return { status: 'replayed', records }
}
