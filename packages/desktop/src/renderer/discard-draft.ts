import type { ConversationView } from '../shared/protocol.js'
import { EMPTY_CONVERSATION_TITLE } from './project-draft-reuse.js'

/**
 * Whether closing this tab throws away something the person wrote. Only a draft pane counts: a
 * conversation never written in that holds typed text or attachments. A conversation that has
 * messages keeps its unsent text for when it is opened again, as it always has.
 */
export function holdsDiscardableDraft({
	view,
	thread,
	draft,
	attachmentCount,
}: {
	view: Pick<ConversationView, 'title' | 'palId'> | undefined
	/** Absent when the conversation was not opened in this window yet. */
	thread: { messages: readonly unknown[]; running: boolean } | undefined
	draft: string
	attachmentCount: number
}): boolean {
	if (!view || view.palId || view.title !== EMPTY_CONVERSATION_TITLE) return false
	if (thread && (thread.messages.length > 0 || thread.running)) return false
	return draft.trim().length > 0 || attachmentCount > 0
}
