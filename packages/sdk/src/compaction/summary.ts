import { createSystemMessage } from '../types/message/index.js'
import type { Message, ToolRevealReceipt } from '../types/message/index.js'

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
 * The closing instruction after every summary. It is written for the first
 * request after a pass, when the model has only the summary and no memory of
 * the steps it describes. Kept out of {@link COMPACTION_HEADER}, which prompt
 * caching and the replace-in-place check both read byte for byte, and kept
 * constant so the same summary always renders the same message.
 */
export const COMPACTION_RESUME_NOTE =
	'Carry on from where this summary says the work stood, without asking the person to repeat it. Treat steps it marks done as done. Files may have changed or may not be shown in full, so read a file again before editing it. If it names something still running or waiting, check on that first.'

/** The opening of the line that names the deferred tools still loaded after a pass. */
export const COMPACTION_LOADED_TOOLS_PREFIX =
	'Tools you loaded earlier with search_tools are still loaded'

const LOADED_TOOLS_NOTE = new RegExp(`\\n\\n${COMPACTION_LOADED_TOOLS_PREFIX}[^\\n]*$`)

/**
 * The deferred tools a history had loaded: the receipts on its tool messages
 * and on the compaction summaries it already holds, de-duplicated, oldest
 * first. A pass reads this from the messages it is about to cut, so the new
 * summary carries what the old ones did and what the cut span loaded.
 */
export function collectRevealedTools(messages: readonly Message[]): ToolRevealReceipt[] {
	const seen = new Set<string>()
	const out: ToolRevealReceipt[] = []
	for (const message of messages) {
		// A failed result loaded nothing; only tool results and summaries carry receipts.
		if (message.role !== 'tool' && message.role !== 'system') continue
		if (message.role === 'tool' && message.isError) continue
		for (const receipt of message.revealedTools ?? []) {
			const key = `${receipt.sourceKind}\u0000${receipt.sourceId}\u0000${receipt.name}`
			if (seen.has(key)) continue
			seen.add(key)
			out.push(receipt)
		}
	}
	return out
}

function loadedToolsNote(revealed: readonly ToolRevealReceipt[]): string {
	const names = [...new Set(revealed.map((receipt) => receipt.name))]
	return `${COMPACTION_LOADED_TOOLS_PREFIX}: ${names.join(', ')}. Call them directly; load any other deferred tool with search_tools first.`
}

/**
 * `text` without any closing notes this module adds, however many are stacked.
 * An earlier summary is handed to the next pass whole, and a model may repeat
 * its ending; cutting them here keeps each message to one note.
 */
export function withoutClosingNotes(text: string): string {
	let out = text.trimEnd()
	for (;;) {
		const next = [COMPACTION_RESUME_NOTE, COMPACTION_RECOVERY_NOTE]
			.reduce((acc, note) => (acc.endsWith(note) ? acc.slice(0, -note.length).trimEnd() : acc), out)
			.replace(LOADED_TOOLS_NOTE, '')
		if (next === out) return out
		out = next
	}
}

/**
 * The summary, as the system message that replaces what it summarises.
 * `recoveryNote` is appended as its own paragraph, then the resume note, which
 * always closes the message.
 */
export function buildCompactionMessage(
	body: string,
	recoveryNote?: string,
	revealed: readonly ToolRevealReceipt[] = [],
): Message {
	const loaded = revealed.length > 0 ? `\n\n${loadedToolsNote(revealed)}` : ''
	return {
		...createSystemMessage(
			`${COMPACTION_HEADER}\n\n${withoutClosingNotes(body)}${recoveryNote ? `\n\n${recoveryNote}` : ''}${loaded}\n\n${COMPACTION_RESUME_NOTE}`,
		),
		source: { type: 'compaction-summary' },
		...(revealed.length > 0 ? { revealedTools: revealed } : {}),
	}
}
