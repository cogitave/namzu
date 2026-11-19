import { describe, expect, it } from 'vitest'
import { paneChord } from './pane-keys.js'
import { isTerminalAppChord } from './terminal-keys.js'

const key = (over: Partial<Parameters<typeof paneChord>[0]>) => ({
	key: '',
	code: '',
	ctrlKey: false,
	metaKey: false,
	shiftKey: false,
	altKey: false,
	...over,
})

describe('the pane chords', () => {
	it('maps the three keys and leaves Changes and Session without one', () => {
		expect(paneChord(key({ ctrlKey: true, key: "'", code: 'Quote' }), false)).toBe('terminal')
		expect(paneChord(key({ ctrlKey: true, shiftKey: true, key: 'B', code: 'KeyB' }), false)).toBe(
			'browser',
		)
		expect(paneChord(key({ ctrlKey: true, shiftKey: true, key: 'F', code: 'KeyF' }), false)).toBe(
			'files',
		)
		expect(paneChord(key({ metaKey: true, key: "'", code: 'Quote' }), true)).toBe('terminal')
	})

	it('does not take the keys the window already has', () => {
		// Ctrl+B is the sidebar, Ctrl+F is find in a terminal, Ctrl+Shift+A archives.
		expect(paneChord(key({ ctrlKey: true, key: 'b', code: 'KeyB' }), false)).toBeUndefined()
		expect(paneChord(key({ ctrlKey: true, key: 'f', code: 'KeyF' }), false)).toBeUndefined()
		expect(
			paneChord(key({ ctrlKey: true, shiftKey: true, key: 'A', code: 'KeyA' }), false),
		).toBeUndefined()
		expect(
			paneChord(key({ ctrlKey: true, altKey: true, key: "'", code: 'Quote' }), false),
		).toBeUndefined()
		expect(paneChord(key({ metaKey: true, key: "'", code: 'Quote' }), false)).toBeUndefined()
	})

	it('travels on from inside a terminal instead of reaching the program', () => {
		const quote = key({ ctrlKey: true, key: "'", code: 'Quote' })
		expect(isTerminalAppChord(quote, false)).toBe(true)
		expect(
			isTerminalAppChord(key({ ctrlKey: true, shiftKey: true, key: 'F', code: 'KeyF' }), false),
		).toBe(true)
		expect(isTerminalAppChord(key({ ctrlKey: true, key: 'c', code: 'KeyC' }), false)).toBe(false)
	})
})
