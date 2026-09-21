import type { TurnId } from '../../types/ids/index.js'
import type { SessionRecordDraft } from './core.js'

/**
 * Repairing a torn tail (spec §4.1).
 *
 * A crash in the middle of an append leaves a last line with no newline. It
 * is not a record, and appending after it would glue the next record onto the
 * fragment and break the chain for good. So the writer that takes the lease
 * next cuts the log back to the end of its last complete line — durably, and
 * only if the log is still the length it measured — and appends
 * `log_repaired{truncatedBytes, lastGoodSeq}` so the repair is itself on the
 * record.
 *
 * Only a torn TAIL is repaired. A complete line that fails the chain is not a
 * crash artefact, and a writer refuses to append to it: collecting around
 * damage could erase the only bytes that explain it.
 *
 * The record is appended inside the active turn when there is one (the
 * envelope carries `turnId` exactly when a record is inside a turn). A log
 * torn before its `session_started` was complete is cut to zero and gets no
 * record, because nothing may precede `session_started`; the caller starts
 * the session again.
 */

export interface TornTailRepair {
	/** Bytes cut from the end of the log. */
	readonly truncatedBytes: number
	/** The last complete record kept; 0 when the log was cut to nothing. */
	readonly lastGoodSeq: number
	/** The active turn at the repair, if any. */
	readonly activeTurnId?: TurnId
}

/** The `log_repaired` record for a repair, or `undefined` when the log was cut to nothing. */
export function repairRecordDraft(repair: TornTailRepair): SessionRecordDraft | undefined {
	if (repair.truncatedBytes <= 0 || repair.lastGoodSeq === 0) return undefined
	return {
		type: 'log_repaired',
		...(repair.activeTurnId === undefined ? {} : { turnId: repair.activeTurnId }),
		truncatedBytes: repair.truncatedBytes,
		lastGoodSeq: repair.lastGoodSeq,
	} as SessionRecordDraft
}
