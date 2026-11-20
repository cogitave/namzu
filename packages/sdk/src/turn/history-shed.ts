import { SPILL_MARKER } from '../runtime/query/tool-output-budget.js'
import type { Message } from '../types/message/index.js'

/** What a cleared tool result starts with; see `compaction/tool-result-editing.ts`. */
const CLEARED_RESULT_PREFIX = '[tool output cleared]'

/**
 * The one rule about the conversation's own history, in the words every place
 * that tells the model about history uses.
 */
export const ANSWER_FROM_VISIBLE_HISTORY =
	'If the answer is in your own earlier messages or tool results that are visible now, answer from them; do not search. Use the history tools only for something no longer visible (after compaction or a restart).'

/**
 * Whether the conversation as the model sees it has lost content: a compaction
 * left a summary in place of messages, a tool result was cleared, or a tool
 * result was cut when it was stored and points at the file that holds the rest. Until then
 * everything said and observed is still in view, so a pointer to the history
 * tools would only send the model to look for what it is already holding.
 */
export function historyContentShed(messages: readonly Message[]): boolean {
	return messages.some(
		(message) =>
			(message.role === 'system' && message.source?.type === 'compaction-summary') ||
			(message.role === 'tool' &&
				typeof message.content === 'string' &&
				(message.content.startsWith(CLEARED_RESULT_PREFIX) ||
					message.content.includes(SPILL_MARKER))),
	)
}
