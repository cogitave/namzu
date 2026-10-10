/**
 * Archiving several conversations in a row keeps one notice: "3 conversations archived" with
 * one Undo that restores all of them. A batch ends when its notice has been on screen for its
 * whole lifetime.
 */
export interface ArchiveBatch {
	ids: readonly string[]
	/** When the notice for this batch goes away. */
	until: number
}

export function addToArchiveBatch(
	batch: ArchiveBatch | undefined,
	id: string,
	now: number,
	lifetimeMs: number,
): ArchiveBatch {
	const live = batch && batch.until > now ? batch.ids : []
	return { ids: live.includes(id) ? live : [...live, id], until: now + lifetimeMs }
}

export function archiveNoticeText(count: number): string {
	return count <= 1
		? 'Conversation archived. Find it under Archived conversations in the sidebar.'
		: `${count} conversations archived. Find them under Archived conversations in the sidebar.`
}
