/** An exact excerpt; matching never rewrites the text or its UTF-16 positions. */
export interface EvidencePassage {
	hit: number
	start: number
	end: number
	next: number
}

/** Literal matching only. The escaped expression has no caller-selected regex operators. */
export function passageMatcher(query: string, caseSensitive: boolean) {
	const expression = caseSensitive
		? undefined
		: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
	return (text: string, from: number): EvidencePassage | undefined => {
		let hit: number
		let length = query.length
		if (expression) {
			expression.lastIndex = from
			const match = expression.exec(text)
			hit = match?.index ?? -1
			length = match?.[0].length ?? length
		} else hit = text.indexOf(query, from)
		if (hit < 0 || (from >= text.length && query !== '')) return undefined
		let start = Math.max(0, hit - 120)
		if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start--
		let end = Math.min(text.length, start + 512)
		if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
		// Nearby hits already fully shown by this excerpt need no second copy.
		// A match crossing its end still deserves a complete later excerpt.
		let next =
			end === text.length || query === '' ? text.length : Math.max(hit + 1, end - length + 1)
		if (/[\uDC00-\uDFFF]/.test(text[next] ?? '')) next++
		return { hit, start, end, next }
	}
}

/** Overlap bytes support boundary matches; starts in those bytes belong to the next window. */
export function passagesInWindow(
	text: string,
	from: number,
	match: ReturnType<typeof passageMatcher>,
	limit: number,
	ownedBytes = Number.POSITIVE_INFINITY,
): { passages: EvidencePassage[]; next: number } {
	const passages: EvidencePassage[] = []
	let next = from
	while (passages.length < limit) {
		const passage = match(text, next)
		if (!passage || Buffer.byteLength(text.slice(0, passage.hit)) >= ownedBytes)
			return { passages, next: text.length }
		passages.push(passage)
		next = passage.next
		if (next >= text.length) break
	}
	return { passages, next }
}
