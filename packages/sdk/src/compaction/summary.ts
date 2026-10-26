import { createSystemMessage } from '../types/message/index.js'
import type { Message } from '../types/message/index.js'

/**
 * The one marker that says a message is a compaction summary.
 *
 * It lived in the iteration phase, which is a layer above this module, so
 * anything down here that needed it — a host-callable compaction, for one —
 * either could not reach it or would have had to import upward. Two copies
 * of the string is the other way that goes, and then a rename in one of
 * them makes every prior summary invisible to the check that drops it.
 */
export const COMPACTION_HEADER =
	'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.'

/**
 * Identity check for a prior compaction summary in the leading floor.
 *
 * Used to replace a summary produced by the SAME run in place, and by restore
 * paths to preserve summaries whose state was produced elsewhere. A retained
 * summary is deliberately not replaceable: it is the only surviving record
 * of an opaque older span.
 */
export function isCompactionMessage(content: string | null | undefined): boolean {
	return typeof content === 'string' && content.startsWith(COMPACTION_HEADER)
}

/**
 * The line that tells the model where exact earlier text can still be had. A
 * host that mounts `search_conversation` and `read_conversation` adds it to
 * every summary; a host without them adds nothing, because a pointer to a tool
 * that is not there is worse than none.
 */
export const COMPACTION_RECOVERY_NOTE =
	'Earlier output was cut from this summary. To get exact earlier text, call search_conversation, then read_conversation.'

/**
 * The summary, as the system message that replaces what it summarises.
 * `recoveryNote` is appended as its own paragraph.
 */
export function buildCompactionMessage(body: string, recoveryNote?: string): Message {
	return {
		...createSystemMessage(
			`${COMPACTION_HEADER}\n\n${body}${recoveryNote ? `\n\n${recoveryNote}` : ''}`,
		),
		source: { type: 'compaction-summary' },
	}
}
