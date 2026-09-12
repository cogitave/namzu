import { evidenceTokenMatcher } from '../../utils/evidence-tokens.js'

/** An exact excerpt; matching never rewrites the text or its UTF-16 positions. */
export interface EvidencePassage {
	hit: number
	start: number
	end: number
	next: number
}

/** Exact substring or token matching, without caller-selected regex operators. */
export function passageMatcher(
	query: string | readonly string[],
	caseSensitive: boolean,
	matchMode: 'literal' | 'token' = 'literal',
) {
	const terms = typeof query === 'string' ? [query] : query
	const tokenMatch = matchMode === 'token' ? evidenceTokenMatcher(terms, caseSensitive) : undefined
	const expression =
		caseSensitive && typeof query === 'string'
			? undefined
			: new RegExp(
					terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
					caseSensitive ? 'g' : 'giu',
				)
	const maxLength = Math.max(...terms.map((term) => term.length))
	const find = (text: string, from: number) => {
		if (tokenMatch) return tokenMatch(text, from)
		if (expression) {
			expression.lastIndex = from
			const match = expression.exec(text)
			return match ? { index: match.index, length: match[0].length } : undefined
		}
		const index = text.indexOf(terms[0] ?? '', from)
		return index < 0 ? undefined : { index, length: terms[0]?.length ?? 0 }
	}
	return (text: string, from: number): EvidencePassage | undefined => {
		const hit = find(text, from)?.index ?? -1
		if (hit < 0 || (from >= text.length && query !== '')) return undefined
		let start = Math.max(0, hit - 120)
		if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start--
		let end = Math.min(text.length, start + 512)
		if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--
		// Nearby hits already fully shown by this excerpt need no second copy.
		// A match crossing its end still deserves a complete later excerpt.
		let next =
			end === text.length || query === '' ? text.length : Math.max(hit + 1, end - maxLength + 1)
		if (typeof query !== 'string' && end < text.length) {
			// Different term lengths share one excerpt. Skip fully visible short
			// matches, but keep the earliest long match that crosses its boundary.
			let at = next
			next = end
			while (at < end) {
				const crossing = find(text, at)
				if (!crossing || crossing.index >= end) break
				if (crossing.index + crossing.length > end) {
					next = crossing.index
					break
				}
				at = crossing.index + 1
				if (/[\uDC00-\uDFFF]/.test(text[at] ?? '')) at++
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
