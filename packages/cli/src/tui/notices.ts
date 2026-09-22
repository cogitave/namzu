import type { TranscriptMessage } from './types.js'

/** The fields of a row about to be written that decide whether it repeats the last one. */
export interface NoticeCandidate {
	readonly role: TranscriptMessage['role']
	readonly content: string
	readonly pending?: boolean
	readonly glyph?: string
	readonly detail?: readonly string[]
	readonly activity?: TranscriptMessage['activity']
}

/**
 * Whether `candidate` is a system notice identical to the row just before it.
 *
 * A notice printed twice in a row reads as two events. The refusal an
 * operator saw after pressing a key twice — "Permissions were not changed…"
 * on two consecutive lines — said nothing the first line had not, and made
 * the key look as if it had been handled twice. So the notice layer drops
 * the second copy; the caller does not have to remember.
 *
 * Deliberately narrow. Only `system` rows, only when the text, mark and
 * (absent) body match exactly, and only against the LAST row: the same notice
 * after anything else in between is news again, and a tool row or a reply
 * that happens to repeat itself is the model's output, which this layer never
 * edits.
 */
export function isRepeatedNotice(
	last: TranscriptMessage | undefined,
	candidate: NoticeCandidate,
): boolean {
	if (!last || candidate.role !== 'system' || last.role !== 'system') return false
	if (candidate.pending || last.pending) return false
	if ((candidate.detail?.length ?? 0) > 0 || (last.detail?.length ?? 0) > 0) return false
	if (candidate.activity || last.activity || last.statusRows || last.checklist) return false
	return last.content === candidate.content && last.glyph === candidate.glyph
}
