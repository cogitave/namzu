import { describe, expect, it } from 'vitest'

import { createShellExpansionSlot } from './shell-expansion-slot.js'

describe('the text a typed command waits with between its two passes', () => {
	it('hands the text to the resubmission of the same line', () => {
		const slot = createShellExpansionSlot()
		const entry = slot.put('/probe', 'out')
		expect(slot.take('/probe')).toBe('out')
		slot.settle(entry)
		// Picked up: the line's later passes (a hook's resubmission) still find it.
		expect(slot.holds('/probe')).toBe(true)
		expect(slot.take('/probe')).toBe('out')
	})

	it('drops the text when the resubmission was turned aside, so the same line runs again later', () => {
		const slot = createShellExpansionSlot()
		const entry = slot.put('/probe', 'old output')
		// The resubmission was queued behind a busy turn: nothing took the text.
		slot.settle(entry)
		expect(slot.holds('/probe')).toBe(false)
		expect(slot.take('/probe')).toBeUndefined()
	})

	it('never hands the text to another line', () => {
		const slot = createShellExpansionSlot()
		slot.put('/probe', 'out')
		expect(slot.take('/probe two')).toBeUndefined()
	})

	it('does not drop a newer entry when an older one settles', () => {
		const slot = createShellExpansionSlot()
		const older = slot.put('/a', 'a')
		slot.put('/b', 'b')
		slot.settle(older)
		expect(slot.take('/b')).toBe('b')
	})
})
