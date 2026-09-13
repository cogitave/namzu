/** The lexical units shared by evidence discovery and bounded relevance scoring. */
export function evidenceTokens(text: string): string[] {
	return Array.from(evidenceTokenEntries(text), (match) => match[0])
}

/** Iterate large stored text without materializing a token array. */
export function evidenceTokenEntries(text: string): IterableIterator<RegExpExecArray> {
	return text.matchAll(/[\p{L}\p{N}_]+/gu)
}

/** No stemming, locale-sensitive folding or accent normalization. */
export function evidenceTokenKey(token: string, caseSensitive = false): string {
	return caseSensitive ? token : token.toLowerCase()
}

export function isEvidenceToken(text: string): boolean {
	return /^[\p{L}\p{N}_]+$/u.test(text)
}

/** `from` may lie inside a token; such a suffix must not become a new word. */
export function evidenceTokenMatcher(terms: readonly string[], caseSensitive: boolean) {
	const wanted = new Set(terms.map((term) => evidenceTokenKey(term, caseSensitive)))
	const expression = /(?<![\p{L}\p{N}_])[\p{L}\p{N}_]+/gu
	return (text: string, from: number): { index: number; length: number } | undefined => {
		expression.lastIndex = from
		for (let match = expression.exec(text); match; match = expression.exec(text)) {
			if (wanted.has(evidenceTokenKey(match[0], caseSensitive)))
				return { index: match.index, length: match[0].length }
		}
		return undefined
	}
}
