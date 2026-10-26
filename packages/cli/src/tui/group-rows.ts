import { groupText, mergeGroups } from './read-search-group.js'
import type { TranscriptMessage } from './types.js'

/** Calls inside a group's body are told apart by a blank line. */
export function joinSections(
	body: readonly string[] | undefined,
	section: readonly string[],
): readonly string[] {
	if (section.length === 0) return body ?? []
	return body && body.length > 0 ? [...body, '', ...section] : section
}

/**
 * Rows that are one call each and sit next to one another become one counted
 * line, as they would have live. A row that is not a settled group between
 * them (text, an edit, a failure) ends the run.
 */
export function mergeGroupRows(rows: readonly TranscriptMessage[]): readonly TranscriptMessage[] {
	const out: TranscriptMessage[] = []
	for (const row of rows) {
		const last = out.at(-1)
		if (row.group && !row.pending && last?.group && !last.pending) {
			const group = mergeGroups(last.group, row.group)
			out[out.length - 1] = {
				...last,
				group,
				content: groupText(group, false),
				detail: joinSections(last.detail, row.detail ?? []),
			}
			continue
		}
		out.push(row)
	}
	return out
}
