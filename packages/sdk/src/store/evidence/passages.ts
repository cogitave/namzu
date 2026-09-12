/** An exact excerpt; matching never rewrites the text or its UTF-16 positions. */
export interface EvidencePassage {
	hit: number
	start: number
	end: number
	next: number
}

/** Literal matching only. The escaped expression has no caller-selected regex operators. */
export function passageMatcher(query: string | readonly string[], caseSensitive: boolean) {
	const terms = typeof query === 'string' ? [query] : query
	const expression =
		caseSensitive && typeof query === 'string'
			? undefined
			: new RegExp(
					terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
					caseSensitive ? 'g' : 'giu',
				)
	const maxLength = Math.max(...terms.map((term) => term.length))
	return (text: string, from: number): EvidencePassage | undefined => {
		let hit: number
		if (expression) {
			expression.lastIndex = from
			const match = expression.exec(text)
			hit = match?.index ?? -1
		} else hit = text.indexOf(terms[0] ?? '', from)
		if (hit < 0 || (from >= text.length && query !== '')) return undefined
		let start = Math.max(0, hit - 120)
		if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start--
		let end = Math.min(text.length, start + 512)
		if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
		// Nearby hits already fully shown by this excerpt need no second copy.
		// A match crossing its end still deserves a complete later excerpt.
		let next =
			end === text.length || query === '' ? text.length : Math.max(hit + 1, end - maxLength + 1)
		if (typeof query !== 'string' && expression && end < text.length) {
			// Different term lengths share one excerpt. Skip fully visible short
			// matches, but keep the earliest long match that crosses its boundary.
			expression.lastIndex = next
			next = end
			while (expression.lastIndex < end) {
				const crossing = expression.exec(text)
				if (!crossing || crossing.index >= end) break
				if (crossing.index + crossing[0].length > end) {
					next = crossing.index
					break
				}
				expression.lastIndex = crossing.index + 1
				if (/[\uDC00-\uDFFF]/.test(text[expression.lastIndex] ?? '')) expression.lastIndex++
			}
		}
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
