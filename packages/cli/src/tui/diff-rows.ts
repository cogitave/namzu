import type { ToolDiffHunk, ToolFacts } from '@namzu/sdk'

import { clipText } from './truncation.js'

/** A created file shows this many rows before the fold. */
export const CREATE_PREVIEW_ROWS = 10
/** An edit shows its hunks whole up to this many rows before the fold. */
export const EDIT_PREVIEW_ROWS = 40

/** A diff body for a tool row: the rows and how many of them show before the fold. */
export interface DiffBody {
	readonly rows: readonly string[]
	readonly preview: number
}

/** The rows `diffRows` draws between two hunks. */
export const HUNK_GAP = '...'

/** `  12 + text`: the right-aligned line number, the marker, then the line. */
const ROW = /^\s*\d+ ([+-]) /

/** Which marker a diff row carries, or undefined for context and gaps. */
export function diffRowMarker(row: string): '+' | '-' | undefined {
	const marker = ROW.exec(row)?.[1]
	return marker === '+' || marker === '-' ? marker : undefined
}

/**
 * Hunks as terminal rows: a right-aligned line-number gutter, a `+`, `-` or
 * space marker, the line, and a dim `...` where unchanged lines were skipped
 * between two hunks. Removed lines are numbered in the old file, the rest in
 * the new one.
 */
export function diffRows(hunks: readonly ToolDiffHunk[]): string[] {
	const last = hunks.reduce(
		(most, hunk) => Math.max(most, hunk.oldStart + hunk.oldLines, hunk.newStart + hunk.newLines),
		1,
	)
	const width = String(last).length
	const rows: string[] = []
	hunks.forEach((hunk, index) => {
		if (index > 0) rows.push(HUNK_GAP)
		let oldLine = hunk.oldStart
		let newLine = hunk.newStart
		for (const row of hunk.lines) {
			const marker = row[0] ?? ' '
			const text = row.slice(1)
			const number = marker === '-' ? oldLine : newLine
			if (marker === '-') oldLine += 1
			else if (marker === '+') newLine += 1
			else {
				oldLine += 1
				newLine += 1
			}
			rows.push(`${String(number).padStart(width)} ${marker} ${text}`)
		}
	})
	return rows
}

/**
 * The body under a finished edit or write, from the typed facts the kernel
 * reported: undefined when they carry no hunks (an older saved conversation,
 * another tool, or a change with nothing in it), so the caller keeps whatever
 * body it already had.
 */
export function diffBodyFromFacts(facts: ToolFacts | undefined): DiffBody | undefined {
	if (!facts || (facts.kind !== 'edit' && facts.kind !== 'write')) return undefined
	const hunks = facts.hunks
	if (!hunks || hunks.length === 0) return undefined
	const created = facts.kind === 'write' && facts.operation === 'created'
	return {
		rows: diffRows(hunks).map((row) => clipText(row, 600)),
		preview: created ? CREATE_PREVIEW_ROWS : EDIT_PREVIEW_ROWS,
	}
}
