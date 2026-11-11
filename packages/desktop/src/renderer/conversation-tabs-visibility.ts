import type { ConversationView } from '../shared/protocol.js'

/** The last known answer to "show conversation tabs", so the first paint matches the saved choice. */
export const SHOW_TABS_HINT_KEY = 'namzu.show-conversation-tabs'

export function readShowTabsHint(storage: Pick<Storage, 'getItem'>): boolean {
	try {
		return storage.getItem(SHOW_TABS_HINT_KEY) === '1'
	} catch {
		return false
	}
}

export function writeShowTabsHint(storage: Pick<Storage, 'setItem'>, show: boolean): void {
	try {
		storage.setItem(SHOW_TABS_HINT_KEY, show ? '1' : '0')
	} catch {
		/* The hint is a convenience; the saved setting is the truth. */
	}
}

/**
 * With the strip hidden, opening a conversation shows it in place of the one before. The tabs
 * that were open stay in the pane's layout (closing a tab never touches its conversation), so
 * this names the ones to close: ordinary conversations other than the one opened. A terminal, a
 * Pal's tab and a tab the catalogue does not know yet are left alone.
 */
export function tabsReplacedOnOpen(
	opened: Pick<ConversationView, 'id' | 'palId'>,
	groupTabs: readonly string[],
	conversations: readonly Pick<ConversationView, 'id' | 'palId'>[],
): string[] {
	if (opened.palId) return []
	const known = new Map(conversations.map((item) => [item.id, item]))
	return groupTabs.filter((id) => {
		if (id === opened.id) return false
		const view = known.get(id)
		return view !== undefined && !view.palId
	})
}
