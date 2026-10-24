import type { ToolFacts } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import {
	CREATE_PREVIEW_ROWS,
	EDIT_PREVIEW_ROWS,
	HUNK_GAP,
	diffBodyFromFacts,
	diffRowMarker,
	diffRows,
} from './diff-rows.js'

describe('diff rows', () => {
	it('draws a right-aligned line-number gutter, markers and context', () => {
		const rows = diffRows([
			{
				oldStart: 8,
				oldLines: 4,
				newStart: 8,
				newLines: 4,
				lines: [' eight', '-nine', '+NINE', ' ten', ' eleven'],
			},
		])
		expect(rows).toEqual([' 8   eight', ' 9 - nine', ' 9 + NINE', '10   ten', '11   eleven'])
		expect(rows.map(diffRowMarker)).toEqual([undefined, '-', '+', undefined, undefined])
	})

	it('puts a dim gap between hunks', () => {
		const rows = diffRows([
			{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] },
			{ oldStart: 50, oldLines: 1, newStart: 50, newLines: 1, lines: ['-c', '+d'] },
		])
		expect(rows[2]).toBe(HUNK_GAP)
		expect(rows).toHaveLength(5)
		expect(rows[3]).toBe('50 - c')
	})

	it('does not mistake output that looks like a row for a marker without the gutter', () => {
		expect(diffRowMarker('+ not a diff row')).toBeUndefined()
		expect(diffRowMarker('...')).toBeUndefined()
	})
})

describe('the body under an edit or a write', () => {
	const hunks = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]

	it('shows a created file as its first lines with the short preview', () => {
		const facts: ToolFacts = { kind: 'write', path: '/p/n.txt', operation: 'created', hunks }
		expect(diffBodyFromFacts(facts)).toEqual({
			rows: ['1 + a', '2 + b'],
			preview: CREATE_PREVIEW_ROWS,
		})
		expect(CREATE_PREVIEW_ROWS).toBe(10)
	})

	it('shows an overwrite and an edit as a diff', () => {
		const write: ToolFacts = { kind: 'write', path: '/p/w.txt', operation: 'updated', hunks }
		const edit: ToolFacts = { kind: 'edit', path: '/p/e.txt', hunks }
		expect(diffBodyFromFacts(write)?.preview).toBe(EDIT_PREVIEW_ROWS)
		expect(diffBodyFromFacts(edit)?.rows).toHaveLength(2)
	})

	it('has no opinion without hunks, so a saved conversation keeps its body', () => {
		expect(diffBodyFromFacts({ kind: 'edit', path: '/p/e.txt' })).toBeUndefined()
		expect(diffBodyFromFacts(undefined)).toBeUndefined()
		expect(diffBodyFromFacts({ kind: 'read', path: '/p/e.txt' })).toBeUndefined()
	})
})
