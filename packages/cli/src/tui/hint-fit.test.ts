import { describe, expect, it } from 'vitest'

import { fitHintPlain, hintSuffix } from './hint-fit.js'
import { wrapChoiceText } from './terminal-choice-text.js'
import { CLICK_EXPAND_HINT, EXPAND_HINT } from './truncation.js'

const ROW = 'general-purpose (Check c) · 4 tool uses · 525 tokens · 2s'

/** True when the hint is on one row whole, or not there at all (or its short form). */
function whole(rows: readonly string[], hint: string, short: string): boolean {
	const text = rows.join('\n')
	const parts = hint.split(' ')
	if (text.includes(hint) || text.includes(short)) return true
	// Left off: no word of it anywhere.
	return !parts.some((word) => word.length > 3 && text.includes(word))
}

describe('fitHintPlain', () => {
	it('does not change a row where the hint fits, to the cell', () => {
		for (const hint of [EXPAND_HINT, CLICK_EXPAND_HINT]) {
			for (const sep of [' ', ' · ']) {
				const text = `${ROW}${sep}${hint}`
				const width = text.length
				for (let w = width; w <= 200; w += 7) expect(fitHintPlain(text, w)).toBe(text)
			}
		}
	})

	it('never cuts the hint across rows at any width from 20 to 200', () => {
		for (const [hint, short] of [
			[EXPAND_HINT, '(ctrl+o)'],
			[CLICK_EXPAND_HINT, '(click)'],
		] as const) {
			for (const sep of [' ', ' · ']) {
				for (const body of [
					ROW,
					`${ROW} ${ROW}`,
					'x',
					'a b c d e f g h i j k l m n o p q r s t u v',
				]) {
					for (let width = 20; width <= 200; width++) {
						const rows = wrapChoiceText(fitHintPlain(`${body}${sep}${hint}`, width), width)
						expect(whole(rows, hint, short), `${width}: ${rows.join('|')}`).toBe(true)
					}
				}
			}
		}
	})

	it('moves the hint whole to its own row and drops the separator', () => {
		const text = `${ROW} · ${CLICK_EXPAND_HINT}`
		const rows = wrapChoiceText(fitHintPlain(text, 70), 70)
		expect(rows.at(-1)).toBe(CLICK_EXPAND_HINT)
		expect(rows.at(-2)?.endsWith('·')).toBe(false)
	})

	it('keeps a size note with the hint, and uses the short form when the hint is wider than the row', () => {
		const text = `… +1,200 lines ${EXPAND_HINT} (~300 KB)`
		expect(wrapChoiceText(fitHintPlain(text, 30), 30)).toEqual([
			'… +1,200 lines',
			`${EXPAND_HINT} (~300 KB)`,
		])
		const rows = wrapChoiceText(fitHintPlain(text, 12), 12)
		expect(rows.join('\n')).not.toContain('to expand')
	})

	it('leaves the hint off when not even the short form fits', () => {
		expect(fitHintPlain(`words here ${CLICK_EXPAND_HINT}`, 5)).toBe('words here')
	})

	it('leaves text without a hint alone', () => {
		expect(fitHintPlain('nothing to expand here', 10)).toBe('nothing to expand here')
	})

	it('hintSuffix gives what follows the text', () => {
		expect(hintSuffix('ab', ` ${EXPAND_HINT}`, 80)).toBe(` ${EXPAND_HINT}`)
		expect(hintSuffix('a'.repeat(70), ` ${EXPAND_HINT}`, 80)).toBe(`\n${EXPAND_HINT}`)
	})
})
