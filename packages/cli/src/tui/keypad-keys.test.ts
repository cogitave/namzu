import { describe, expect, it } from 'vitest'

import { installKeypadKeys, normalizeKeypadKeys } from './keypad-keys.js'

const ESC = '\x1b'
const kp = (code: number, tail = '') => `${ESC}[${String(code)}${tail}u`

describe('normalizeKeypadKeys', () => {
	it('turns every keypad character into the character the main key types', () => {
		const expected = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
		expected.forEach((digit, index) => {
			expect(normalizeKeypadKeys(kp(57399 + index))).toBe(digit)
		})
		expect(normalizeKeypadKeys(kp(57409))).toBe('.')
		expect(normalizeKeypadKeys(kp(57410))).toBe('/')
		expect(normalizeKeypadKeys(kp(57411))).toBe('*')
		expect(normalizeKeypadKeys(kp(57412))).toBe('-')
		expect(normalizeKeypadKeys(kp(57413))).toBe('+')
		expect(normalizeKeypadKeys(kp(57415))).toBe('=')
		expect(normalizeKeypadKeys(kp(57416))).toBe(',')
	})

	it('turns the keypad Enter into Enter', () => {
		expect(normalizeKeypadKeys(kp(57414))).toBe('\r')
	})

	it('turns the keypad navigation keys into the main ones', () => {
		expect(normalizeKeypadKeys(kp(57417))).toBe(`${ESC}[D`)
		expect(normalizeKeypadKeys(kp(57418))).toBe(`${ESC}[C`)
		expect(normalizeKeypadKeys(kp(57419))).toBe(`${ESC}[A`)
		expect(normalizeKeypadKeys(kp(57420))).toBe(`${ESC}[B`)
		expect(normalizeKeypadKeys(kp(57421))).toBe(`${ESC}[5~`)
		expect(normalizeKeypadKeys(kp(57422))).toBe(`${ESC}[6~`)
		expect(normalizeKeypadKeys(kp(57423))).toBe(`${ESC}[H`)
		expect(normalizeKeypadKeys(kp(57424))).toBe(`${ESC}[F`)
		expect(normalizeKeypadKeys(kp(57425))).toBe(`${ESC}[2~`)
		expect(normalizeKeypadKeys(kp(57426))).toBe(`${ESC}[3~`)
	})

	it('drops the keypad begin key', () => {
		expect(normalizeKeypadKeys(`a${kp(57427)}b`)).toBe('ab')
	})

	it('keeps a held modifier, as the main key reports it', () => {
		// shift+KP_ENTER is shift+Enter; ctrl+KP_UP is ctrl+Up; alt+KP_5 is alt+5.
		expect(normalizeKeypadKeys(kp(57414, ';2'))).toBe(`${ESC}[13;2u`)
		expect(normalizeKeypadKeys(kp(57419, ';5'))).toBe(`${ESC}[1;5A`)
		expect(normalizeKeypadKeys(kp(57404, ';3'))).toBe(`${ESC}[53;3u`)
		expect(normalizeKeypadKeys(kp(57426, ';5'))).toBe(`${ESC}[3;5~`)
	})

	it('ignores Num Lock and Caps Lock, which change no key', () => {
		expect(normalizeKeypadKeys(kp(57414, ';129'))).toBe('\r')
		expect(normalizeKeypadKeys(kp(57401, ';65'))).toBe('2')
		expect(normalizeKeypadKeys(kp(57414, ';130'))).toBe(`${ESC}[13;130u`)
	})

	it('treats a press event like a plain press', () => {
		expect(normalizeKeypadKeys(kp(57414, ';1:1'))).toBe('\r')
	})

	it('keeps a repeat and a release event on the main key, so they are treated as its own are', () => {
		expect(normalizeKeypadKeys(kp(57414, ';1:2'))).toBe(`${ESC}[13;1:2u`)
		expect(normalizeKeypadKeys(kp(57414, ';1:3'))).toBe(`${ESC}[13;1:3u`)
		expect(normalizeKeypadKeys(kp(57419, ';1:2'))).toBe(`${ESC}[1;1:2A`)
		expect(normalizeKeypadKeys(kp(57426, ';1:3'))).toBe(`${ESC}[3;1:3~`)
		expect(normalizeKeypadKeys(kp(57401, ';1:3'))).toBe(`${ESC}[50;1:3u`)
	})

	it('leaves every other byte alone', () => {
		for (const text of [
			'hello',
			`${ESC}[A`,
			`${ESC}[13;2u`,
			`${ESC}[57398u`,
			`${ESC}[57428u`,
			`${ESC}[200~57414${ESC}[201~`,
			'57414u',
		]) {
			expect(normalizeKeypadKeys(text)).toBe(text)
		}
	})

	it('reads the keypad of a terminal in application keypad mode', () => {
		const ss3 = (final: string, mod = '') => `${ESC}O${mod}${final}`
		expect(normalizeKeypadKeys(ss3('M'))).toBe('\r')
		'pqrstuvwxy'.split('').forEach((final, index) => {
			expect(normalizeKeypadKeys(ss3(final))).toBe(String(index))
		})
		expect(normalizeKeypadKeys(ss3('j'))).toBe('*')
		expect(normalizeKeypadKeys(ss3('k'))).toBe('+')
		expect(normalizeKeypadKeys(ss3('l'))).toBe(',')
		expect(normalizeKeypadKeys(ss3('m'))).toBe('-')
		expect(normalizeKeypadKeys(ss3('n'))).toBe('.')
		expect(normalizeKeypadKeys(ss3('o'))).toBe('/')
		expect(normalizeKeypadKeys(ss3('X'))).toBe('=')
		// A modifier digit before the letter is the held modifier: shift+KP_ENTER is shift+Enter.
		expect(normalizeKeypadKeys(ss3('M', '2'))).toBe(`${ESC}[13;2u`)
		expect(normalizeKeypadKeys(`hi${ss3('M')}`)).toBe('hi\r')
	})

	it('keeps the SS3 keys that are not keypad keys', () => {
		for (const text of [
			`${ESC}OA`,
			`${ESC}OB`,
			`${ESC}OC`,
			`${ESC}OD`,
			`${ESC}OH`,
			`${ESC}OF`,
			`${ESC}OP`,
			`${ESC}OS`,
			`${ESC}O`,
		]) {
			expect(normalizeKeypadKeys(text)).toBe(text)
		}
	})

	it('rewrites several keys in one read', () => {
		expect(normalizeKeypadKeys(`${kp(57400)}${kp(57401)}x${kp(57414)}`)).toBe('12x\r')
	})
})

describe('installKeypadKeys', () => {
	it('rewrites what the reader gets and puts read back on undo', () => {
		const queue: Array<string | null> = [kp(57414), null]
		const stream = { read: () => queue.shift() ?? null }
		const original = stream.read
		const undo = installKeypadKeys(stream)
		expect(stream.read()).toBe('\r')
		expect(stream.read()).toBeNull()
		undo()
		expect(stream.read).toBe(original)
	})
})
