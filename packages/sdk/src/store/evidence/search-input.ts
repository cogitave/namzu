import { z } from 'zod'
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
export function evidenceSearchInput(input: { query?: string; terms?: string[] }) {
	if (input.terms && input.query !== undefined)
		throw new Error('Supply either a literal query or literal terms, not both.')
	const terms = input.terms
		? [...new Set(input.terms)].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
		: undefined
	return {
		query: input.query ?? '',
		terms,
		termsKey: terms ? digest(JSON.stringify(terms)) : undefined,
		browse: !terms && !input.query,
	}
}
