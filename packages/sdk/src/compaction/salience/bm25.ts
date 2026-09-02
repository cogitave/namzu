/**
 * BM25 over the run's own messages.
 *
 * The corpus is small — a few hundred documents at most — so the index
 * is rebuilt from term frequencies each pass rather than maintained
 * incrementally; the arithmetic is the cost of a few string splits. The
 * constants are the textbook ones (k1 = 1.2, b = 0.75). What matters
 * here is not ranking quality against a web corpus but that a message
 * mentioning the goal's identifiers outscores one that does not, and
 * that a term every message contains (the run's own file name, say)
 * stops counting.
 */

import { termFrequencies, tokenize } from './tokenize.js'

export interface Bm25Document {
	readonly tf: ReadonlyMap<string, number>
	readonly length: number
}

export interface Bm25Index {
	readonly documents: readonly Bm25Document[]
	readonly documentFrequency: ReadonlyMap<string, number>
	readonly averageLength: number
}

const K1 = 1.2
const B = 0.75

export function indexDocument(text: string): Bm25Document {
	const tokens = tokenize(text)
	return { tf: termFrequencies(tokens), length: tokens.length }
}

export function buildIndex(documents: readonly Bm25Document[]): Bm25Index {
	const documentFrequency = new Map<string, number>()
	let total = 0
	for (const doc of documents) {
		total += doc.length
		for (const term of doc.tf.keys()) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
		}
	}
	return {
		documents,
		documentFrequency,
		averageLength: documents.length === 0 ? 0 : total / documents.length,
	}
}

/** BM25 score of one document for a query given as tokens. */
export function bm25Score(
	index: Bm25Index,
	doc: Bm25Document,
	queryTokens: readonly string[],
): number {
	if (doc.length === 0 || index.documents.length === 0) return 0
	const n = index.documents.length
	let score = 0
	const seen = new Set<string>()
	for (const term of queryTokens) {
		if (seen.has(term)) continue
		seen.add(term)
		const tf = doc.tf.get(term)
		if (!tf) continue
		const df = index.documentFrequency.get(term) ?? 0
		const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
		const norm = tf + K1 * (1 - B + (B * doc.length) / Math.max(1, index.averageLength))
		score += idf * ((tf * (K1 + 1)) / norm)
	}
	return score
}
