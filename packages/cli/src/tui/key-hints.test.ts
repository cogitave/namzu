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

	describe('short forms', () => {
		const provider = [
			{ text: '↑↓ or 1–9 select', short: '↑↓ select', rank: 5 },
			{ text: 'enter apply', rank: 5 },
			{ text: 'k enter an API key', short: 'k API key', rank: 3 },
			{ text: 'l create a Namzu sign-in', short: 'l sign-in', rank: 2 },
			{ text: 'esc or ctrl+c exit', short: 'esc exit', rank: 5 },
		]

		it('says a low-ranked hint short before it gives the hint up', () => {
			const full = fitHints(provider, 200)
			expect(full).toBe(
				'↑↓ or 1–9 select · enter apply · k enter an API key · l create a Namzu sign-in · esc or ctrl+c exit',
			)
			// One column short: the lowest hint is the one that gets shorter.
			expect(fitHints(provider, full.length - 1)).toBe(
				'↑↓ or 1–9 select · enter apply · k enter an API key · l sign-in · esc or ctrl+c exit',
			)
		})

		it('never loses the keys that must stay, and says them short when it has to', () => {
			expect(fitHints(provider, 37)).toBe('↑↓ select · enter apply · esc exit')
			expect(fitHints(provider, 52)).toBe('↑↓ or 1–9 select · enter apply · esc or ctrl+c exit')
		})

		it('gives every hint it keeps whole, at every width from 34 up', () => {
			const known = new Set(provider.flatMap((hint) => [hint.text, hint.short]))
			for (let width = 34; width <= 140; width++) {
				const line = fitHints(provider, width)
				expect(line.length, `width ${width}`).toBeLessThanOrEqual(width)
				for (const hint of line.split(' · ')) expect(known.has(hint), hint).toBe(true)
				expect(line).toContain('enter apply')
				expect(line).toMatch(/esc( or ctrl\+c)? exit/)
				expect(line).toMatch(/↑↓( or 1–9)? select/)
			}
		})
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
