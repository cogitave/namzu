/**
 * Which conversations need the person right now, derived from what main already knows about each
 * one. A conversation needs the person while its turn is running and an approval card or a
 * question is waiting for an answer; a finished reply is "unread", which is a different marker and
 * never counts here. Pure: no window, no clock, no Electron.
 */
export interface AttentionRow {
	id: string
	running: boolean
	/** Approval cards and questions waiting for an answer. */
	waiting: number
	/** A Pal's conversation is background work for a person who did not start it. */
	pal?: boolean
}

/** The ids that need the person, in the order given, each once. */
export function needsYouIds(rows: Iterable<AttentionRow>): string[] {
	const ids: string[] = []
	const seen = new Set<string>()
	for (const row of rows) {
		if (!row.running || row.waiting <= 0 || row.pal || seen.has(row.id)) continue
		seen.add(row.id)
		ids.push(row.id)
	}
	return ids
}

/** The sentence a screen reader gets for the count on the app icon. */
export function attentionDescription(count: number): string {
	if (count <= 0) return ''
	return count === 1 ? '1 conversation needs you' : `${count} conversations need you`
}
