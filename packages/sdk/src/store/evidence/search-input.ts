import { z } from 'zod'
import { evidenceTokenKey, isEvidenceToken } from '../../utils/evidence-tokens.js'
import { digest } from './format.js'

export const evidenceTermsSchema = z
	.array(
		z
			.string()
			.min(1)
			.max(256)
			.refine((text) => text.trim().length > 0),
	)
	.min(1)
	.max(16)
	.optional()

/** Canonical membership binds continuations without putting long term lists in cursors. */
export function evidenceSearchInput(input: {
	query?: string
	terms?: string[]
	matchMode?: 'literal' | 'token'
}) {
	if (input.terms && input.query !== undefined)
		throw new Error('Supply either a literal query or literal terms, not both.')
	const terms = input.terms
		? [...new Set(input.terms)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
		: undefined
	if (input.matchMode === 'token' && !(terms ?? [input.query ?? '']).every(isEvidenceToken))
		throw new Error('Token search requires nonempty letter/number/underscore tokens.')
	return {
		query: input.query ?? '',
		terms,
		termsKey: terms ? digest(JSON.stringify(terms)) : undefined,
		browse: !terms && !input.query,
	}
}

/** Refinement only narrows matching; it never resets scope, filters or position. */
export function evidenceTermRefinement(
	input: {
		terms?: readonly string[]
		cursor?: string
		matchMode?: string
		caseSensitive?: boolean
	},
	refined: readonly string[],
): string[] {
	const terms = evidenceTermsSchema.parse(refined)
	if (
		!input.cursor ||
		input.matchMode !== 'token' ||
		!input.terms ||
		!terms?.every(isEvidenceToken)
	)
		throw new Error('Term refinement requires a token cursor and its original terms.')
	const key = (term: string) => evidenceTokenKey(term, input.caseSensitive ?? true)
	const original = new Set(input.terms.map(key))
	const subset = new Set(terms.map(key))
	if (subset.size >= original.size || [...subset].some((term) => !original.has(term)))
		throw new Error('Term refinement must be a strict nonempty subset of the original terms.')
	return terms
}
