import { describe, expect, it } from 'vitest'
import { pressReturnsKeyboard } from './terminal-pane-focus.js'

const inside = (match: boolean) => ({ closest: () => (match ? {} : null) })

describe('pressReturnsKeyboard', () => {
	it('returns the keyboard to the program after a press on dead space', () => {
		expect(pressReturnsKeyboard(inside(false))).toBe(true)
		expect(pressReturnsKeyboard(null)).toBe(true)
	})
	it('leaves a press on a control or the find box alone', () => {
		expect(pressReturnsKeyboard(inside(true))).toBe(false)
	})
})
