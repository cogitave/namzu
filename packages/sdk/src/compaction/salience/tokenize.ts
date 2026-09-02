/**
 * An identifier-aware tokenizer for scoring, not for search.
 *
 * A coding conversation's vocabulary is paths, identifiers and error
 * names. A word tokenizer sees `src/store.mjs` as one token that matches
 * nothing and `removeTodo` as another; the model, asked about `store`,
 * is looking at both. So a path splits on its separators, a `camelCase`
 * or `snake_case` identifier splits into its words AND keeps its whole
 * form, and a dotted attribute key (`namzu.run.id`) yields both the key
 * and its parts. Everything is lower-cased; nothing is stemmed, because
 * a stemmer that turns `tests` into `test` also turns `testing` into it,
 * and the false matches cost more than the missed ones in a corpus this
 * small. Stop words are the handful that carry no relevance in any
 * sentence and would otherwise dominate term frequency.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'for',
	'from',
	'i',
	'if',
	'in',
	'is',
	'it',
	'of',
	'on',
	'or',
	'that',
	'the',
	'then',
	'this',
	'to',
	'was',
	'will',
	'with',
	'you',
])

const WORD = /[\p{L}\p{N}_$][\p{L}\p{N}_$.\-/\\:]*/gu

function splitIdentifier(raw: string): string[] {
	const parts = raw
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[_\s]+/)
		.filter((p) => p.length > 0)
	return parts.length > 1 ? parts : []
}

/** Tokens of `text`, lower-cased, with identifiers and paths opened up. */
export function tokenize(text: string): string[] {
	const out: string[] = []
	for (const match of text.matchAll(WORD)) {
		const raw = match[0].replace(/^[.\-/\\:]+|[.\-/\\:]+$/g, '')
		if (raw.length === 0) continue
		const whole = raw.toLowerCase()
		if (!STOP_WORDS.has(whole)) out.push(whole)
		// Separators first: a path or dotted key contributes each segment.
		const segments = raw.split(/[/\\.:\-]+/).filter((s) => s.length > 0)
		if (segments.length > 1) {
			for (const segment of segments) {
				const lower = segment.toLowerCase()
				if (!STOP_WORDS.has(lower) && lower !== whole) out.push(lower)
				for (const part of splitIdentifier(segment)) out.push(part.toLowerCase())
			}
		} else {
			for (const part of splitIdentifier(raw)) {
				const lower = part.toLowerCase()
				if (!STOP_WORDS.has(lower)) out.push(lower)
			}
		}
	}
	return out
}

/** Term frequencies of `tokens`. */
export function termFrequencies(tokens: readonly string[]): Map<string, number> {
	const tf = new Map<string, number>()
	for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
	return tf
}
