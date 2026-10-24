import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import type { ToolDiffHunk, ToolFacts } from '@namzu/sdk'
import { structuredPatch } from 'diff'

import {
	CREATE_PREVIEW_ROWS,
	type DiffInfo,
	WORKSPACE_PREVIEW_ROWS,
	editSummary,
	plainDiffRows,
	writeSummary,
} from './diff-view.js'
import { displayPath } from './display-path.js'
import { clipText } from './truncation.js'

export { CREATE_PREVIEW_ROWS, HUNK_GAP } from './diff-view.js'

/** `/diff` shows its hunks whole up to this many rows before the fold. */
export const EDIT_PREVIEW_ROWS = WORKSPACE_PREVIEW_ROWS

/** A diff body for a tool row: the plain rows (for copy and export) and what is needed to draw them. */
export interface DiffBody {
	readonly rows: readonly string[]
	readonly diff: DiffInfo
}

/** Added and removed rows in a set of hunks. */
function countRows(hunks: readonly ToolDiffHunk[]): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const hunk of hunks) {
		for (const row of hunk.lines) {
			if (row.startsWith('+')) added += 1
			else if (row.startsWith('-')) removed += 1
		}
	}
	return { added, removed }
}

function bodyOf(info: DiffInfo): DiffBody {
	return { rows: plainDiffRows(info).map((row) => clipText(row, 600)), diff: info }
}

/**
 * The body under a finished edit or write, from the typed facts the kernel
 * reported: undefined when they carry no hunks (an older saved conversation,
 * another tool, or a change with nothing in it), so the caller keeps whatever
 * body it already had.
 *
 * An edit and an overwrite read `Added N lines, removed M lines` over the
 * hunks, all of them. A created file reads `Wrote N lines to <path>` over its
 * first ten lines.
 */
export function diffBodyFromFacts(
	facts: ToolFacts | undefined,
	cwd?: string,
): DiffBody | undefined {
	if (!facts || (facts.kind !== 'edit' && facts.kind !== 'write')) return undefined
	const hunks = facts.hunks ?? []
	const carried = countRows(hunks)
	const added = facts.added ?? carried.added
	const removed = facts.removed ?? carried.removed
	const created = facts.kind === 'write' && facts.operation === 'created'
	// Nothing changed, or the kernel did not say what: the caller keeps its own words.
	if (hunks.length === 0 && (created ? added === 0 : added === 0 && removed === 0)) return undefined
	if (facts.kind === 'write' && (facts.operation === 'unchanged' || facts.operation === 'wrote'))
		return undefined
	const truncated = facts.hunksTruncated === true ? ({ truncated: true } as const) : {}
	if (created) {
		return bodyOf({
			mode: 'file',
			hunks,
			preview: CREATE_PREVIEW_ROWS,
			added,
			removed,
			...truncated,
			summary: writeSummary(added, displayPath(facts.path, cwd)),
		})
	}
	return bodyOf({
		mode: 'hunks',
		hunks,
		added,
		removed,
		...truncated,
		summary: editSummary(added, removed),
	})
}

/** What a call asked for, kept from its start to draw if the person refuses it. */
export type ProposedChange =
	| {
			readonly kind: 'edit'
			readonly path?: string
			readonly before: string
			readonly after: string
	  }
	| { readonly kind: 'write'; readonly content: string }

/** Lines the body of a refused write can carry; the rest only counts. */
const PROPOSED_LINE_CAP = 400
/** A file bigger than this is not read to find where an edit would have landed. */
const LOCATE_MAX_BYTES = 2 * 1024 * 1024

/** The proposed change from a call's own input, or undefined for any other call. */
export function proposedFromInput(toolName: string, input: unknown): ProposedChange | undefined {
	if (typeof input !== 'object' || input === null) return undefined
	const fields = input as Record<string, unknown>
	const name = toolName.toLowerCase()
	if (name === 'write') {
		const content = fields.content ?? fields.newStr
		return typeof content === 'string' && content.length > 0
			? { kind: 'write', content }
			: undefined
	}
	if (name === 'edit') {
		const before = fields.old_string ?? fields.oldStr
		const after = fields.new_string ?? fields.newStr
		if (typeof before !== 'string' || typeof after !== 'string') return undefined
		return {
			kind: 'edit',
			...(typeof fields.path === 'string' ? { path: fields.path } : {}),
			before,
			after,
		}
	}
	return undefined
}

/** The line a snippet starts on in the file as it is now, or 1 when it cannot be found. */
function startLine(path: string | undefined, snippet: string, cwd: string | undefined): number {
	if (!path || snippet.length === 0) return 1
	try {
		const full = isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path)
		if (statSync(full).size > LOCATE_MAX_BYTES) return 1
		const text = readFileSync(full, 'utf8')
		const at = text.indexOf(snippet)
		if (at < 0) return 1
		let line = 1
		for (let i = text.indexOf('\n'); i >= 0 && i < at; i = text.indexOf('\n', i + 1)) line += 1
		return line
	} catch {
		return 1
	}
}

function withNewline(text: string): string {
	return text.length === 0 || text.endsWith('\n') ? text : `${text}\n`
}

/**
 * The change a refused edit or write would have made, drawn with the dimmed
 * colours so it reads as what was turned down. An edit is a line diff of the
 * two strings the call carried, numbered from where the old text sits in the
 * file now; a write is its first lines.
 */
export function proposedBody(
	proposed: ProposedChange | undefined,
	cwd?: string,
): DiffBody | undefined {
	if (!proposed) return undefined
	if (proposed.kind === 'write') {
		const lines = withNewline(proposed.content).split('\n')
		lines.pop()
		const carried = lines.slice(0, PROPOSED_LINE_CAP)
		return bodyOf({
			mode: 'file',
			hunks: [
				{
					oldStart: 0,
					oldLines: 0,
					newStart: 1,
					newLines: carried.length,
					lines: carried.map((line) => `+${line}`),
				},
			],
			preview: CREATE_PREVIEW_ROWS,
			added: lines.length,
			removed: 0,
			dim: true,
			...(lines.length > carried.length ? { truncated: true as const } : {}),
		})
	}
	const patch = structuredPatch(
		'a',
		'a',
		withNewline(proposed.before),
		withNewline(proposed.after),
		undefined,
		undefined,
		{
			context: 3,
		},
	)
	const offset = startLine(proposed.path, proposed.before, cwd) - 1
	const hunks: ToolDiffHunk[] = patch.hunks.map((hunk) => ({
		oldStart: hunk.oldStart + offset,
		oldLines: hunk.oldLines,
		newStart: hunk.oldStart + offset,
		newLines: hunk.newLines,
		lines: hunk.lines.filter((row) => !row.startsWith('\\')),
	}))
	if (hunks.length === 0) return undefined
	const counts = countRows(hunks)
	return bodyOf({ mode: 'hunks', hunks, dim: true, ...counts })
}
