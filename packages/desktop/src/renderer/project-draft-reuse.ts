import type { ConversationView } from '../shared/protocol.js'

/**
 * The draft this window last opened for a project, when it is still untouched: it exists, belongs
 * to the project, has no message, no turn running and no typed text.
 * Switching to a project then returns to that draft instead of creating another conversation
 * (a native session and a synchronous save) that nobody ever prompts.
 */
export function reusableProjectDraft({
	candidate,
	projectId,
	conversations,
	thread,
	draftText,
}: {
	candidate: string | undefined
	projectId: string
	conversations: readonly Pick<ConversationView, 'id' | 'projectId' | 'palId'>[]
	thread: { messages: readonly unknown[]; running: boolean } | undefined
	draftText: string | undefined
}): string | undefined {
	if (!candidate) return undefined
	const view = conversations.find((item) => item.id === candidate)
	if (!view || view.projectId !== projectId || view.palId) return undefined
	if (thread && (thread.messages.length > 0 || thread.running)) return undefined
	if (draftText) return undefined
	return candidate
}

/** The title a conversation keeps until its first message names it. */
export const EMPTY_CONVERSATION_TITLE = 'New conversation'

/** The newest conversation of the project that was never written in, if one exists. */
export function emptyProjectConversation(
	conversations: readonly Pick<
		ConversationView,
		'id' | 'projectId' | 'palId' | 'title' | 'updatedAt'
	>[],
	projectId: string,
): string | undefined {
	let best: (typeof conversations)[number] | undefined
	for (const item of conversations) {
		if (item.projectId !== projectId || item.palId || item.title !== EMPTY_CONVERSATION_TITLE)
			continue
		if (!best || item.updatedAt > best.updatedAt) best = item
	}
	return best?.id
}
