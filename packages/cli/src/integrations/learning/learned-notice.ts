import { stripVTControlCharacters } from 'node:util'
import type { GeneratorOutcome } from './generator-run.js'

const MAX_CHARS = 110

/**
 * The one plain line shown when learning by itself changed the folder's
 * guidance: what it learned, and how to take it back. Only an activated
 * revision is announced; a rejected or inconclusive cycle changes nothing, so
 * it says nothing.
 */
export function describeLearned(
	outcome: Extract<GeneratorOutcome, { status: 'ran' }>,
): string | null {
	if (outcome.cycle.status !== 'activated') return null
	if (outcome.proposal?.status !== 'proposed') return null
	const chars = Array.from(
		stripVTControlCharacters(outcome.proposal.candidate.description)
			.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
	)
	const learned =
		chars.length > MAX_CHARS
			? `${chars
					.slice(0, MAX_CHARS - 1)
					.join('')
					.trimEnd()}…`
			: chars.join('')
	if (!learned) return null
	return `Namzu learned something for this folder: ${learned} Undo with \`namzu learn --undo\`.`
}
