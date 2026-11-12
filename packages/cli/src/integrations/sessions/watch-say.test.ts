import { describe, expect, it } from 'vitest'
import { SayLine } from './watch-say.js'

describe('the watcher’s one line', () => {
	it('opens on m, collects what is typed, and submits on Enter', () => {
		const line = new SayLine()
		expect(line.feed('x')).toEqual([])
		expect(line.open).toBe(false)
		expect(line.feed('m')).toEqual([{ kind: 'compose', text: '' }])
		expect(line.open).toBe(true)
		// An m typed inside the line is text, not the key.
		expect(line.feed('m')).toEqual([{ kind: 'compose', text: 'm' }])
		line.feed('/stop')
		expect(line.feed('\r')).toEqual([{ kind: 'submit', text: 'm/stop' }])
		expect(line.open).toBe(false)
	})

	it('cancels on Esc or on an empty Enter, and edits with Backspace and Ctrl+U', () => {
		const line = new SayLine()
		line.feed('m')
		line.feed('ab')
		expect(line.feed('\x7f')).toEqual([{ kind: 'compose', text: 'a' }])
		expect(line.feed('\x15')).toEqual([{ kind: 'compose', text: '' }])
		expect(line.feed('\r')).toEqual([{ kind: 'cancel' }])
		line.feed('m')
		line.feed('hello')
		expect(line.feed('\x1b')).toEqual([{ kind: 'cancel' }])
		expect(line.open).toBe(false)
		// Esc with the line closed is nothing.
		expect(line.feed('\x1b')).toEqual([])
	})

	it('leaves on Ctrl+C whether or not the line is open', () => {
		const line = new SayLine()
		expect(line.feed('\x03')).toEqual([{ kind: 'leave' }])
		line.feed('m')
		expect(line.feed('\x03')).toEqual([{ kind: 'leave' }])
	})

	it('drops control and direction characters and escape sequences, and the rest of a paste after a line break', () => {
		const line = new SayLine()
		line.feed('m')
		expect(line.feed('\x1b[A')).toEqual([])
		line.feed('a\x07b‮c​d')
		expect(line.feed('\rm tail')).toEqual([{ kind: 'submit', text: 'abcd' }])
		// "m tail" came after the line break: it is not typed as keys, so the line stays closed.
		expect(line.open).toBe(false)
	})
})
