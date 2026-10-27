import { describe, expect, it } from 'vitest'

import { backgroundHint, isBackgroundChord } from './foreground-handoff.js'

describe('backgroundHint', () => {
	it('names the one key outside tmux', () => {
		expect(backgroundHint({})).toBe('(ctrl+b to run in background)')
		expect(backgroundHint({ TMUX: '' })).toBe('(ctrl+b to run in background)')
	})

	it('says to press it twice inside tmux, which keeps the first press', () => {
		expect(backgroundHint({ TMUX: '/tmp/tmux-1000/default,1,0' })).toBe(
			'(ctrl+b ctrl+b (twice) to run in background)',
		)
	})
})

describe('isBackgroundChord', () => {
	it('is Ctrl+B and nothing else', () => {
		expect(isBackgroundChord('b', { ctrl: true })).toBe(true)
		expect(isBackgroundChord('b', { ctrl: false })).toBe(false)
		expect(isBackgroundChord('f', { ctrl: true })).toBe(false)
	})
})
