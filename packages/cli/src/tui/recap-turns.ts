/**
 * What the recap reads from the transcript: which rows are typed prompts,
 * which are finished replies, and which are earlier recaps. Tool output,
 * notices and queued deliveries from a schedule are none of these.
 */

import type { RecapTurn } from '../integrations/sessions/recap.js'
import type { RecapRowKind } from './away-recap.js'
import type { TranscriptMessage } from './types.js'

function kindOf(message: TranscriptMessage): RecapRowKind | undefined {
	if (message.kind === 'recap') return 'recap'
	if (message.pending) return undefined
	if (message.role === 'user' && !message.sourceDelivery && message.content.trim().length > 0) {
		return 'prompt'
	}
	if (message.role === 'assistant' && message.content.trim().length > 0) return 'reply'
	return undefined
}

/** The rows the countdown rules count, oldest first. */
export function recapRows(messages: readonly TranscriptMessage[]): readonly RecapRowKind[] {
	const rows: RecapRowKind[] = []
	for (const message of messages) {
		const kind = kindOf(message)
		if (kind !== undefined) rows.push(kind)
	}
	return rows
}

/** The prompts and replies, oldest first, for the digest. */
export function recapTurns(messages: readonly TranscriptMessage[]): readonly RecapTurn[] {
	const turns: RecapTurn[] = []
	for (const message of messages) {
		const kind = kindOf(message)
		if (kind === 'prompt') turns.push({ role: 'user', text: message.content })
		else if (kind === 'reply') turns.push({ role: 'assistant', text: message.content })
	}
	return turns
}
