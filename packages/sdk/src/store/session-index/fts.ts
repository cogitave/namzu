import type { SessionRecord } from '../../types/session/records.js'
import { evidenceTokenMatcher, isEvidenceToken } from '../../utils/evidence-tokens.js'

/**
 * Evidence search over the session logs: which text a record contributes,
 * and what counts as a match.
 *
 * The text sources and the match rules are today's evidence search
 * (`store/evidence`): a tool result, an assistant message's text, and the
 * messages a compaction shed; literal substring or whole-token matching,
 * case-sensitive by default, no regex operators, no ranking. `evidence_fts`
 * (FTS5, trigram tokenizer) only narrows the candidates. Every candidate is
 * checked here, so the SQLite index and the scan index return the same hits.
 */

/** One searchable text part of one record. */
export interface EvidenceText {
	/** The part's position among the record's text parts. */
	readonly part: number
	/** `tool_completed`, `message_completed`, or `compaction_shed:<role|summary>`. */
	readonly source: string
	readonly text: string
	readonly toolName?: string
	readonly isError?: boolean
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

const ROLES = new Set(['system', 'user', 'assistant', 'tool'])

/**
 * The texts of shed messages, in today's order: every plain-string message
 * first, then the text blocks of tool messages. Binary blocks are never text.
 */
function shedTexts(messages: unknown): { source: string; text: string }[] {
	if (!Array.isArray(messages)) return []
	const strings: { source: string; text: string }[] = []
	const blocks: { source: string; text: string }[] = []
	for (const value of messages) {
		const message = plainObject(value)
		if (!message || typeof message.role !== 'string' || !ROLES.has(message.role)) continue
		const role = message.role
		if (typeof message.content === 'string') {
			const summary =
				role === 'system' && plainObject(message.source)?.type === 'compaction-summary'
			strings.push({
				source: `compaction_shed:${summary ? 'summary' : role}`,
				text: message.content,
			})
		} else if (role === 'tool' && Array.isArray(message.content)) {
			for (const block of message.content) {
				const part = plainObject(block)
				if (part?.type === 'text' && typeof part.text === 'string') {
					blocks.push({ source: 'compaction_shed:tool', text: part.text })
				}
			}
		}
	}
	return strings.concat(blocks)
}

/** The searchable text parts of one record; empty for a record that carries none. */
export function evidenceTexts(record: SessionRecord): EvidenceText[] {
	switch (record.type) {
		case 'tool_completed':
			return typeof record.result === 'string'
				? [
						{
							part: 0,
							source: 'tool_completed',
							text: record.result,
							toolName: record.toolName,
							isError: record.isError,
						},
					]
				: []
		case 'message_completed':
			return typeof record.content === 'string'
				? [{ part: 0, source: 'message_completed', text: record.content }]
				: []
		case 'compaction_shed':
			return shedTexts(record.messages).map((text, part) => ({ part, ...text }))
		default:
			return []
	}
}

/** What to look for. Exactly today's evidence-search options. */
export interface EvidenceQuery {
	/** A literal string. An empty query (or none) matches every part. */
	readonly query?: string
	/** One to sixteen literal terms, matched as alternatives. Exclusive with `query`. */
	readonly terms?: readonly string[]
	/** `literal` (the default) matches substrings; `token` matches whole letter/number/underscore tokens. */
	readonly matchMode?: 'literal' | 'token'
	/** Defaults to true. */
	readonly caseSensitive?: boolean
}

/** Where the first match in a text is, and the excerpt around it (UTF-16 positions). */
export interface EvidenceMatch {
	readonly hit: number
	readonly start: number
	readonly end: number
}

export class EvidenceQueryError extends Error {
	override readonly name = 'EvidenceQueryError'
}

const LOW_SURROGATE = /[\uDC00-\uDFFF]/

function queryTerms(query: EvidenceQuery): readonly string[] {
	if (query.terms !== undefined && query.query !== undefined) {
		throw new EvidenceQueryError('Supply either a literal query or literal terms, not both.')
	}
	if (query.terms !== undefined) {
		if (query.terms.length === 0 || query.terms.length > 16) {
			throw new EvidenceQueryError('Supply between one and sixteen terms.')
		}
		for (const term of query.terms) {
			if (term.trim().length === 0 || term.length > 256) {
				throw new EvidenceQueryError('Each term is nonblank and at most 256 characters.')
			}
		}
		return [...new Set(query.terms)]
	}
	return [query.query ?? '']
}

/**
 * The matcher for a query: the first hit in a text and the excerpt a result
 * shows for it (up to 120 characters before the hit, 512 in all, never
 * splitting a surrogate pair), or `undefined` when the text does not match.
 */
export function evidenceMatcher(query: EvidenceQuery): (text: string) => EvidenceMatch | undefined {
	const terms = queryTerms(query)
	const caseSensitive = query.caseSensitive ?? true
	const single = query.terms === undefined
	let find: (text: string) => number
	if (query.matchMode === 'token') {
		if (!terms.every(isEvidenceToken)) {
			throw new EvidenceQueryError(
				'Token search requires nonempty letter/number/underscore tokens.',
			)
		}
		const match = evidenceTokenMatcher(terms, caseSensitive)
		find = (text) => match(text, 0)?.index ?? -1
	} else if (caseSensitive && single) {
		const needle = terms[0] ?? ''
		find = (text) => text.indexOf(needle)
	} else {
		const expression = new RegExp(
			terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
			caseSensitive ? 'g' : 'giu',
		)
		find = (text) => {
			expression.lastIndex = 0
			return expression.exec(text)?.index ?? -1
		}
	}
	return (text) => {
		const hit = find(text)
		if (hit < 0) return undefined
		let start = Math.max(0, hit - 120)
		if (start > 0 && LOW_SURROGATE.test(text[start] ?? '')) start--
		let end = Math.min(text.length, start + 512)
		if (end < text.length && LOW_SURROGATE.test(text[end] ?? '')) end--
		return { hit, start, end }
	}
}

/**
 * Characters that a case-insensitive JavaScript match folds onto an ASCII
 * letter although SQLite's folding may not (U+212A KELVIN SIGN onto `k`,
 * U+017F LONG S onto `s`). A case-insensitive term containing `k` or `s`
 * therefore gets no FTS narrowing, so the narrowing can never drop a hit.
 */
const FOLDS_FROM_NON_ASCII = /[ks]/i
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/

/**
 * The FTS5 `MATCH` expression that narrows the candidates for a query, or
 * `undefined` when narrowing could drop a hit and every part must be checked.
 *
 * The trigram tokenizer folds ASCII case and matches a quoted string as a
 * substring, so for printable-ASCII terms of three or more characters its
 * result is a superset of the literal and token matches.
 */
export function ftsMatchExpression(query: EvidenceQuery): string | undefined {
	const terms = queryTerms(query)
	const caseSensitive = query.caseSensitive ?? true
	for (const term of terms) {
		if (term.length < 3 || !PRINTABLE_ASCII.test(term)) return undefined
		if (!caseSensitive && FOLDS_FROM_NON_ASCII.test(term)) return undefined
	}
	return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' OR ')
}
