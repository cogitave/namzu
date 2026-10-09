/** Room for a title in a tab and in a sidebar row, in characters; the full title is the tooltip. */
export const TAB_TITLE_CHARS = 26
export const ROW_TITLE_CHARS = 34

/**
 * A title cut at a word boundary with an ellipsis, so a row never ends in half a word. A single
 * very long word (a path, an address) is cut where it must be. The text is counted in code
 * points, so a letter such as İ or a emoji is never split.
 */
export function shortenTitle(title: string, limit: number): string {
	const clean = title.replace(/\s+/g, ' ').trim()
	const letters = [...clean]
	if (letters.length <= limit) return clean
	const head = letters.slice(0, limit).join('')
	// A boundary only counts when it keeps at least half of the room, so one early short word
	// does not leave the row nearly empty.
	const boundary = head.lastIndexOf(' ')
	const kept = boundary >= limit / 2 ? head.slice(0, boundary) : head
	return `${kept.replace(/[\s,;:.\-–—(]+$/u, '')}…`
}
