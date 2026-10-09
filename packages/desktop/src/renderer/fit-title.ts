/**
 * Picks the text a tab or row shows in the room it has, never cutting through a letter of a word
 * that could be kept whole. `candidates` run from the most to the least informative (for
 * example `sh 7 · project`, then `sh 7`): the first that fits is used whole. When none fits, the
 * last one is cut at a word boundary with an ellipsis; a single word wider than the room is cut
 * where it must be. `measure` returns a text's width in the same unit as `room`.
 */
export function fitTitle(
	candidates: readonly string[],
	room: number,
	measure: (text: string) => number,
): string {
	const clean = candidates.map((item) => item.replace(/\s+/g, ' ').trim()).filter(Boolean)
	if (clean.length === 0) return ''
	for (const item of clean) if (measure(item) <= room) return item
	const last = clean[clean.length - 1] as string
	const words = last.split(' ')
	for (let count = words.length - 1; count >= 1; count--) {
		const head = words
			.slice(0, count)
			.join(' ')
			.replace(/[\s,;:.\-–—(]+$/u, '')
		if (head && measure(`${head}…`) <= room) {
			// A boundary only counts when it keeps at least half of the room, so one early short
			// word does not leave the tab nearly empty; below that the cut falls inside a word.
			if (measure(`${head}…`) >= room / 2) return `${head}…`
			break
		}
	}
	const letters = [...last]
	for (let count = letters.length - 1; count >= 1; count--) {
		const head = letters.slice(0, count).join('').trimEnd()
		if (measure(`${head}…`) <= room) return `${head}…`
	}
	return '…'
}
