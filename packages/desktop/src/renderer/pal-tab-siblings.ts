import type { ConversationView } from '../shared/protocol.js'

/**
 * A Pal shows in one tab at a time. When one of its conversations is opened, any other tab of the
 * same Pal in the pane is a stale view of it and is closed, so "Open Kiro" never leaves two Kiro
 * tabs side by side. The conversations themselves are untouched.
 */
export function stalePalTabs(
	opened: Pick<ConversationView, 'id' | 'palId'>,
	groupTabs: readonly string[],
	conversations: readonly Pick<ConversationView, 'id' | 'palId'>[],
): string[] {
	if (!opened.palId) return []
	const owner = new Map(conversations.map((item) => [item.id, item.palId]))
	return groupTabs.filter((id) => id !== opened.id && owner.get(id) === opened.palId)
}
