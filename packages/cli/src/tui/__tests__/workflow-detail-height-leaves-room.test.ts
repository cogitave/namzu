/**
 * The workflow detail is drawn above the message box. Whatever stands under it (the box with its
 * draft lines, the status line, an extension row) is counted out of the detail's height, so the
 * whole stack fits the terminal; rows past the screen would make every update repaint it all.
 */

import { expect, it } from 'vitest'

import { workflowDetailHeight } from '../AgentExplorer.js'

it('keeps the old height when the rows under it are the usual ones', () => {
	expect(workflowDetailHeight(40, false)).toBe(31)
	expect(workflowDetailHeight(40, true)).toBe(20)
})

it('gives way to a tall draft: the detail plus what is under it never passes the screen', () => {
	for (const rows of [14, 18, 24, 30, 40]) {
		for (const below of [5, 8, 12]) {
			for (const fullscreen of [false, true]) {
				const height = workflowDetailHeight(rows, fullscreen, below)
				expect(height + below).toBeLessThanOrEqual(Math.max(rows, 4 + below))
				if (rows - below >= 4) expect(height + below).toBeLessThanOrEqual(rows)
			}
		}
	}
	// A 24 row terminal with a four-line draft: box 7 + status + 4 of conversation, not a fixed 12 or more.
	expect(workflowDetailHeight(24, false, 7 + 1 + 4)).toBe(12)
	expect(workflowDetailHeight(24, false, 7 + 1 + 4) + 12).toBeLessThanOrEqual(24)
})

it('is not forced to 12 rows on a terminal of 14 rows or fewer', () => {
	const height = workflowDetailHeight(14, false, 4 + 1 + 4)
	expect(height).toBe(5)
	expect(height + 9).toBeLessThanOrEqual(14)
	expect(workflowDetailHeight(10, false, 7)).toBe(4)
})
