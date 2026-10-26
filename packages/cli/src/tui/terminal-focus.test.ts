import { describe, expect, it, vi } from 'vitest'

import { createTerminalFocus } from './terminal-focus.js'

describe('terminal focus', () => {
	it('starts unknown, which counts as focused', () => {
		const focus = createTerminalFocus()
		expect(focus.state()).toBe('unknown')
		expect(focus.isFocused()).toBe(true)
	})

	it('is blurred only after an explicit blur report', () => {
		const focus = createTerminalFocus()
		focus.set(false)
		expect(focus.state()).toBe('blurred')
		expect(focus.isFocused()).toBe(false)
		focus.set(true)
		expect(focus.state()).toBe('focused')
	})

	it('notes when focus came back', () => {
		let now = 100
		const focus = createTerminalFocus(() => now)
		focus.set(false)
		now = 250
		focus.set(true)
		expect(focus.gainedAt()).toBe(250)
	})

	it('ignores a second blur and reports each real change once', () => {
		const focus = createTerminalFocus()
		const listener = vi.fn()
		focus.subscribe(listener)
		focus.set(false)
		focus.set(false)
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it('treats a key after a blur as proof the person is back', () => {
		const focus = createTerminalFocus()
		focus.noteInput()
		expect(focus.state()).toBe('unknown')
		focus.set(false)
		focus.noteInput()
		expect(focus.state()).toBe('focused')
	})

	it('stops calling a listener that unsubscribed', () => {
		const focus = createTerminalFocus()
		const listener = vi.fn()
		const stop = focus.subscribe(listener)
		stop()
		focus.set(false)
		expect(listener).not.toHaveBeenCalled()
	})
})
