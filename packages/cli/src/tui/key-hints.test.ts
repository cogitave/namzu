import { describe, expect, it } from 'vitest'

import { fitHintText, fitHints } from './key-hints.js'

describe('fitHints', () => {
	const hints = [
		{ text: '↑↓ select', rank: 5 },
		{ text: 'PgUp/PgDn jump', rank: 1 },
		{ text: 'enter apply', rank: 5 },
		{ text: 'esc back', rank: 4 },
	]

	it('joins every hint when they fit', () => {
		expect(fitHints(hints, 80)).toBe('↑↓ select · PgUp/PgDn jump · enter apply · esc back')
	})

	it('drops the least important whole hint, never part of one', () => {
		expect(fitHints(hints, 40)).toBe('↑↓ select · enter apply · esc back')
		const narrow = fitHints(hints, 25)
		expect(narrow).toBe('↑↓ select · enter apply')
		expect(narrow).not.toContain('…')
	})

	it('drops the later of two equal hints first', () => {
		expect(fitHints(['a one', 'b two', 'c three'], 13)).toBe('a one · b two')
	})

	it('returns the last hint whole when even one is too wide', () => {
		expect(fitHints(['enter apply'], 4)).toBe('enter apply')
	})
})

describe('fitHintText', () => {
	it('leaves a line that fits', () => {
		expect(fitHintText('enter steer · tab queue · esc interrupt', 60)).toBe(
			'enter steer · tab queue · esc interrupt',
		)
	})

	it('writes the return key before it drops anything', () => {
		expect(fitHintText('enter steer · tab queue · esc interrupt', 36)).toBe(
			'↵ steer · tab queue · esc interrupt',
		)
	})

	it('then drops middle hints and keeps the key that leaves', () => {
		expect(fitHintText('enter steer · tab queue · esc interrupt', 25)).toBe(
			'↵ steer · esc interrupt',
		)
		expect(fitHintText('↑↓ select · enter apply · esc back', 8)).toBe('esc back')
	})

	it('cuts text with no hints at a word', () => {
		expect(fitHintText('forking conversation — input is paused', 20)).toBe('forking…')
	})
})
