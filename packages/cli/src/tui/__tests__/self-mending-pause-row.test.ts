import { describe, expect, it } from 'vitest'
import { SelfMendingPauseRow } from '../self-mending-pause-row.js'

describe('the self-mending pause row', () => {
	it('is rewritten by later tries of the same run', () => {
		const slot = new SelfMendingPauseRow()
		slot.remember('a')
		expect(slot.reusable(1, new Set(['a']))).toBe('a')
	})

	it('is not reused once a different kind of pause was pushed', () => {
		const slot = new SelfMendingPauseRow()
		slot.remember('a')
		slot.forget()
		expect(slot.reusable(1, new Set(['a']))).toBeNull()
	})

	it('is not reused after the attempt counter reset', () => {
		const slot = new SelfMendingPauseRow()
		slot.remember('a')
		expect(slot.reusable(0, new Set(['a']))).toBeNull()
	})

	it('is not reused when the row is gone', () => {
		const slot = new SelfMendingPauseRow()
		slot.remember('a')
		expect(slot.reusable(2, new Set())).toBeNull()
	})
})
