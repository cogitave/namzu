/**
 * The workflow detail takes the place of the message box and the status line. Its box fills what
 * is left under the conversation by the rule `max(tight ? 8 : 12, min(avail - 1, rows - 6))` at
 * least and `max(tight ? 8 : 11, avail - 1)` at most, and the whole detail never passes the
 * screen: rows past it are not clipped but make every update repaint it all.
 */

import { expect, it } from 'vitest'

import { workflowDetailBoxRows, workflowDetailHeight } from '../AgentExplorer.js'

it('fills the screen under ten rows of conversation', () => {
	expect(workflowDetailBoxRows(47)).toBe(36)
	expect(workflowDetailBoxRows(40)).toBe(29)
	expect(workflowDetailHeight(40)).toBe(35)
})

it('is at least 12 rows tall in a roomy terminal and 8 in a tight one', () => {
	expect(workflowDetailBoxRows(30)).toBe(19)
	expect(workflowDetailBoxRows(24)).toBe(13)
	expect(workflowDetailBoxRows(18)).toBe(8)
	expect(workflowDetailBoxRows(12)).toBe(8)
})

it('never passes the screen, down to a four row floor', () => {
	for (const rows of [6, 10, 14, 18, 24, 30, 40, 47, 60]) {
		const height = workflowDetailHeight(rows)
		expect(height).toBeGreaterThanOrEqual(4)
		expect(height).toBeLessThanOrEqual(Math.max(4, rows - 1))
	}
})
