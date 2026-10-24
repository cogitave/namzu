import { structuredPatch } from 'diff'
import type { ToolDiffHunk } from '../../types/tool/presentation.js'

/** Lines of unchanged text kept around each change, as `git diff` does. */
const CONTEXT_LINES = 3
/** A diff that takes longer than this is abandoned for the coarse count below. */
const DIFF_TIMEOUT_MS = 5000
/** Most hunk rows a result carries; the counts always cover the whole change. */
export const MAX_CARRIED_DIFF_LINES = 400
/** A single carried row is cut here so one minified line cannot bloat an event. */
const MAX_CARRIED_LINE_CHARS = 500

export interface LineDiff {
	/** Lines added and removed, counted from the hunks of a real line diff. */
	readonly added: number
	readonly removed: number
	/** Hunks with three lines of context; rows are ` `, `+` or `-` followed by the line. */
	readonly hunks: readonly ToolDiffHunk[]
	/** Rows were left out of `hunks` to keep the result small. */
	readonly truncated: boolean
}

/** Cut a row without splitting a surrogate pair. */
function cutRow(row: string): string {
	if (row.length <= MAX_CARRIED_LINE_CHARS) return row
	const cut = row.slice(0, MAX_CARRIED_LINE_CHARS - 1).replace(/[\uD800-\uDBFF]$/, '')
	return `${cut}…`
}

function splitKeepingTerminators(text: string): string[] {
	return text.length === 0 ? [] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
}

/**
 * The coarse fallback when the diff cannot finish in time: everything between the
 * common head and tail counts as changed. Never used when a real diff exists.
 */
function coarseDiff(before: string, after: string): LineDiff {
	const a = splitKeepingTerminators(before)
	const b = splitKeepingTerminators(after)
	let head = 0
	while (head < a.length && head < b.length && a[head] === b[head]) head++
	let tail = 0
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	)
		tail++
	const removed = a.slice(head, a.length - tail)
	const added = b.slice(head, b.length - tail)
	const rows = [
		...removed.map((line) => `-${line.replace(/\n$/, '')}`),
		...added.map((line) => `+${line.replace(/\n$/, '')}`),
	]
	const kept = rows.slice(0, MAX_CARRIED_DIFF_LINES).map(cutRow)
	return {
		added: added.length,
		removed: removed.length,
		hunks:
			rows.length === 0
				? []
				: [
						{
							oldStart: head + 1,
							oldLines: removed.length,
							newStart: head + 1,
							newLines: added.length,
							lines: kept,
						},
					],
		truncated: rows.length > kept.length,
	}
}

/**
 * The real line diff between two bodies, the way git counts it.
 *
 * A line ends at its newline, so a body whose only difference is the final
 * newline changes one line on each side (`+1 -1`), never nothing. The counts
 * come from the hunks of a line diff, not from the span between the first and
 * last changed line, so two edits far apart in one file are two lines, not the
 * whole stretch between them.
 */
export function lineDiff(before: string, after: string): LineDiff {
	if (before === after) return { added: 0, removed: 0, hunks: [], truncated: false }
	const patch = structuredPatch('a', 'a', before, after, undefined, undefined, {
		context: CONTEXT_LINES,
		timeout: DIFF_TIMEOUT_MS,
	})
	if (patch === undefined) return coarseDiff(before, after)
	let added = 0
	let removed = 0
	let budget = MAX_CARRIED_DIFF_LINES
	let truncated = false
	const hunks: ToolDiffHunk[] = []
	for (const hunk of patch.hunks) {
		const rows: string[] = []
		for (const row of hunk.lines) {
			// "\ No newline at end of file" describes the row above it; it is not a line.
			if (row.startsWith('\\')) continue
			if (row.startsWith('+')) added++
			else if (row.startsWith('-')) removed++
			if (budget > 0) {
				rows.push(cutRow(row))
				budget--
			} else {
				truncated = true
			}
		}
		if (rows.length > 0) {
			hunks.push({
				oldStart: hunk.oldStart,
				oldLines: hunk.oldLines,
				newStart: hunk.newStart,
				newLines: hunk.newLines,
				lines: rows,
			})
		}
	}
	return { added, removed, hunks, truncated }
}
