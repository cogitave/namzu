import { describe, expect, it } from 'vitest'
import { type TerminalKeyEvent, terminalKeyAction } from './terminal-keys.js'

const press = (key: string, over: Partial<TerminalKeyEvent> = {}): TerminalKeyEvent => ({
	key,
	code: `Key${key.toUpperCase()}`,
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	altKey: false,
	...over,
})
const linux = (selected: boolean) => ({ hasSelection: selected, mac: false })
const mac = (selected: boolean) => ({ hasSelection: selected, mac: true })

describe('terminalKeyAction', () => {
	it('sends Ctrl+C to the program unless text is selected', () => {
		expect(terminalKeyAction(press('c', { ctrlKey: true }), linux(false))).toBe('send')
		expect(terminalKeyAction(press('c', { ctrlKey: true }), linux(true))).toBe('copy')
		expect(terminalKeyAction(press('C', { ctrlKey: true, shiftKey: true }), linux(false))).toBe(
			'copy',
		)
	})

	it('uses Command on a Mac and leaves Control to the program', () => {
		expect(terminalKeyAction(press('c', { metaKey: true }), mac(true))).toBe('copy')
		expect(terminalKeyAction(press('c', { metaKey: true }), mac(false))).toBe('send')
		expect(terminalKeyAction(press('c', { ctrlKey: true }), mac(true))).toBe('send')
		expect(terminalKeyAction(press('v', { metaKey: true }), mac(false))).toBe('paste')
		expect(terminalKeyAction(press('f', { metaKey: true }), mac(false))).toBe('find')
	})

	it('pastes with Ctrl+V and Ctrl+Shift+V and finds with Ctrl+F', () => {
		expect(terminalKeyAction(press('v', { ctrlKey: true }), linux(false))).toBe('paste')
		expect(terminalKeyAction(press('V', { ctrlKey: true, shiftKey: true }), linux(false))).toBe(
			'paste',
		)
		expect(terminalKeyAction(press('f', { ctrlKey: true }), linux(false))).toBe('find')
		expect(terminalKeyAction(press('F', { ctrlKey: true, shiftKey: true }), linux(false))).toBe(
			'send',
		)
	})

	it('recognizes the chord that opens a terminal by key or by physical key', () => {
		const chord = (over: Partial<TerminalKeyEvent>) =>
			press('`', { code: 'Backquote', shiftKey: true, ...over })
		expect(terminalKeyAction(chord({ ctrlKey: true }), linux(false))).toBe('app')
		expect(terminalKeyAction(chord({ key: '~', ctrlKey: true }), linux(false))).toBe('app')
		expect(terminalKeyAction(chord({ metaKey: true }), mac(false))).toBe('app')
		// Without Shift it is the program's: Ctrl+` is not ours.
		expect(terminalKeyAction(chord({ ctrlKey: true, shiftKey: false }), linux(false))).toBe('send')
	})

	it('leaves everything else to the program, including the keys the app uses elsewhere', () => {
		for (const key of ['k', 'n', 'o', 'a', 'e', 'l', 'r', 'u', 'z'])
			expect(terminalKeyAction(press(key, { ctrlKey: true }), linux(false))).toBe('send')
		expect(terminalKeyAction(press('Escape', { code: 'Escape' }), linux(false))).toBe('send')
		expect(terminalKeyAction(press('c', { ctrlKey: true, altKey: true }), linux(true))).toBe('send')
		expect(terminalKeyAction(press('c', { ctrlKey: true, metaKey: true }), linux(true))).toBe(
			'send',
		)
	})

	it('hands the window its own chords: settings, moving between tabs and another terminal', () => {
		const code = (key: string, over: Partial<TerminalKeyEvent> = {}) =>
			press(key, { ctrlKey: true, ...over })
		expect(terminalKeyAction(code(',', { code: 'Comma' }), linux(false))).toBe('app')
		expect(terminalKeyAction(code('Tab', { code: 'Tab' }), linux(false))).toBe('app')
		expect(terminalKeyAction(code('PageDown', { code: 'PageDown' }), linux(false))).toBe('app')
		expect(terminalKeyAction(code('3', { code: 'Digit3' }), linux(false))).toBe('app')
		expect(terminalKeyAction(code('F4', { code: 'F4' }), linux(false))).toBe('app')
		expect(terminalKeyAction(code('|', { code: 'Backslash', shiftKey: true }), linux(false))).toBe(
			'app',
		)
		// Ctrl+W closes the tab, even in a terminal; the interrupt and end-of-input keys stay the program's.
		expect(terminalKeyAction(code('w', { code: 'KeyW' }), linux(false))).toBe('app')
		expect(terminalKeyAction(code('c', { code: 'KeyC' }), linux(false))).toBe('send')
		expect(terminalKeyAction(code('d', { code: 'KeyD' }), linux(false))).toBe('send')
		expect(terminalKeyAction(code('z', { code: 'KeyZ' }), linux(false))).toBe('send')
		expect(terminalKeyAction(code('w', { code: 'KeyW', shiftKey: true }), linux(false))).toBe(
			'send',
		)
	})
})
