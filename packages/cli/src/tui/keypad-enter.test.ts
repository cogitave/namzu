import { describe, expect, it } from 'vitest'

import { installKeypadEnter, rewriteKeypadEnter } from './keypad-enter.js'

const ESC = '\u001b'

describe('the number pad Enter', () => {
	it('is read as the main Enter, with the modifiers the terminal reported', () => {
		expect(rewriteKeypadEnter(`${ESC}[57414u`)).toBe(`${ESC}[13u`)
		expect(rewriteKeypadEnter(`${ESC}[57414;5u`)).toBe(`${ESC}[13;5u`)
		expect(rewriteKeypadEnter(`${ESC}[57414;1:3u`)).toBe(`${ESC}[13;1:3u`)
		expect(rewriteKeypadEnter(`${ESC}OM`)).toBe('\r')
	})

	it('leaves every other key as it came', () => {
		for (const bytes of [
			'hello',
			'\r',
			`${ESC}[13u`,
			`${ESC}[57415u`,
			`${ESC}[574140u`,
			`${ESC}[A`,
		])
			expect(rewriteKeypadEnter(bytes)).toBe(bytes)
		expect(rewriteKeypadEnter(`ab${ESC}[57414ucd`)).toBe(`ab${ESC}[13ucd`)
	})

	it('rewrites what the screen reads, and hands the stream back when removed', () => {
		const reads: (string | null)[] = [`x${ESC}[57414u`, null]
		const stdin = { read: () => reads.shift() ?? null }
		const original = stdin.read
		const remove = installKeypadEnter(stdin)
		expect(stdin.read()).toBe(`x${ESC}[13u`)
		expect(stdin.read()).toBeNull()
		remove()
		expect(stdin.read).toBe(original)
	})
})
