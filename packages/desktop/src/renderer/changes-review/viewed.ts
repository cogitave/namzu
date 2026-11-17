/** "Mark as viewed": a review aid kept on this machine; it changes nothing in git. */
export type ViewedState = 'unviewed' | 'viewed' | 'stale'

/** A short, stable hash of a text (FNV-1a), enough to tell that a file's content moved. */
export function hashText(text: string): string {
	let hash = 0x811c9dc5
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return (hash >>> 0).toString(36)
}

/** What a file looked like when it was marked: its counts, and its text once that was loaded. */
export function fingerprintOf(
	file: { added: number; removed: number },
	after?: string | null,
): string {
	return `${file.added}:${file.removed}:${after == null ? '' : hashText(after)}`
}

/**
 * A viewed file is stale when it has changed since. Before its text is loaded only the counts
 * are compared; once it is loaded, the text decides when the mark carried a text hash too.
 */
export function viewedState(mark: string | undefined, current: string): ViewedState {
	if (mark === undefined) return 'unviewed'
	if (mark === current) return 'viewed'
	const [markCounts = '', markHash = ''] = [
		mark.split(':').slice(0, 2).join(':'),
		mark.split(':')[2],
	]
	const [nowCounts = '', nowHash = ''] = [
		current.split(':').slice(0, 2).join(':'),
		current.split(':')[2],
	]
	if (markCounts !== nowCounts) return 'stale'
	// Same counts: only a loaded text on both sides can tell more.
	return markHash && nowHash && markHash !== nowHash ? 'stale' : 'viewed'
}
