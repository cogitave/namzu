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
 * Used to REPLACE one in place, so at most one `[COMPACTED CONTEXT]` block
 * ever lives in the never-trimmed floor, and by the checkpoint-restore path
 * to PRESERVE the summary across a resume — it is the only surviving record
 * of the older history a run compacted away.
 */
export function isCompactionMessage(content: string | null | undefined): boolean {
	return typeof content === 'string' && content.startsWith(COMPACTION_HEADER)
}

/** The summary, as the system message that replaces what it summarises. */
export function buildCompactionMessage(body: string): Message {
	return createSystemMessage(`${COMPACTION_HEADER}\n\n${body}`)
}
