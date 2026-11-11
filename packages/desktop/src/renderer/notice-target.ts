import type { ConversationView } from '../shared/protocol.js'

export type NoticeClickAction =
	| { kind: 'wait' }
	| { kind: 'open'; view: ConversationView }
	| { kind: 'home' }

/**
 * What a clicked notification does once the window can tell. A click can land just after a reload
 * or while a move is finishing, so it waits for the list of conversations and for the window to
 * be usable; a conversation that is not in the loaded list leads to the Home page, never nowhere.
 */
export function noticeClickAction(
	sessionId: string,
	state: {
		conversations: readonly ConversationView[]
		loaded: boolean
		frozen: boolean
	},
): NoticeClickAction {
	if (state.frozen) return { kind: 'wait' }
	const view = state.conversations.find((item) => item.id === sessionId)
	if (view?.projectId) return { kind: 'open', view }
	return state.loaded ? { kind: 'home' } : { kind: 'wait' }
}
