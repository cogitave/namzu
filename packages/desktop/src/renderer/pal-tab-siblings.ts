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

/** What a conversation holds that the person has not sent yet. */
export interface UnsentReader {
	draft(id: string): Promise<string>
	attachments(id: string): Promise<readonly unknown[]>
}

/**
 * The stale tabs that are safe to close. A tab with an unsent draft or attachments stays open,
 * and so does one that cannot be read: closing it could lose what the person wrote.
 */
export async function closableStaleTabs(
	stale: readonly string[],
	reader: UnsentReader,
): Promise<string[]> {
	const empty = await Promise.all(
		stale.map(async (id) => {
			try {
				const [draft, files] = await Promise.all([reader.draft(id), reader.attachments(id)])
				return draft.trim().length === 0 && files.length === 0
			} catch {
				return false
			}
		}),
	)
	return stale.filter((_, index) => empty[index])
}
