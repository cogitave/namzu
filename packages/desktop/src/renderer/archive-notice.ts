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

/**
 * A conversation that came back is no longer part of the notice: it leaves the batch, and a
 * batch with nothing left to undo is gone. The clock does not restart.
 */
export function removeFromArchiveBatch(
	batch: ArchiveBatch | undefined,
	id: string,
	now: number,
): ArchiveBatch | undefined {
	if (!batch || batch.until <= now) return undefined
	const ids = batch.ids.filter((other) => other !== id)
	return ids.length === 0 ? undefined : { ids, until: batch.until }
}

export function archiveNoticeText(count: number): string {
	return count <= 1
		? 'Conversation archived. Find it with the archive button next to Recents.'
		: `${count} conversations archived. Find them with the archive button next to Recents.`
}
