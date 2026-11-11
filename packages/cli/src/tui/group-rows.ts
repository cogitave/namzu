import { type GroupState, groupText, isOneCommand, mergeGroups } from './read-search-group.js'
import { shellPlainLines } from './shell-cell.js'
import { tokenColor } from './theme.js'
import { EXPAND_HINT } from './truncation.js'
import type { TranscriptMessage } from './types.js'

/** Calls inside a group's body are told apart by a blank line. */
export function joinSections(
	body: readonly string[] | undefined,
	section: readonly string[],
): readonly string[] {
	if (section.length === 0) return body ?? []
	return body && body.length > 0 ? [...body, '', ...section] : section
}

/** What the detailed transcript shows for a command that folded: its header, then its whole output. */
export function commandSection(cell: NonNullable<GroupState['cell']>): readonly string[] {
	return [cell.shell.fullHeader ?? cell.header, ...shellPlainLines(cell.shell)]
}

/**
 * The fields of a row that follow from its group, so the live row, the settled
 * row and a resumed row are the same row. A group of exactly one command is that
 * command's own row (its header and the output under it); any other group is the
 * counted line.
 */
export function groupFields(state: GroupState, live: boolean): Partial<TranscriptMessage> {
	if (isOneCommand(state)) {
		return {
			content: state.cell.header,
			glyph: '●',
			glyphColor: tokenColor('status.ok'),
			shell: state.cell.shell,
			activity: undefined,
			group: state,
		}
	}
	return {
		content: groupText(state, live),
		glyph: ' ',
		glyphColor: tokenColor('text.muted'),
		shell: undefined,
		activity: 'exploration',
		group: state,
	}
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
				...groupFields(group, false),
				meta: EXPAND_HINT,
				detail: joinSections(last.detail, row.detail ?? []),
			}
			continue
		}
		out.push(row)
	}
	return out
}
