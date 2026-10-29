import { describe, expect, it } from 'vitest'
import { copyString } from './copy-string.js'

describe('copyString', () => {
	it.each(['', 'kırmızı\u0000text', '🦉😀', '\ud800before\udfffafter\udbff'])(
		'preserves the exact code units in %j',
		(text) => {
			expect(copyString(text)).toBe(text)
		},
	)

	it('preserves every UTF-16 code unit, including unpaired surrogates', () => {
		const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join('')
		expect(copyString(text)).toBe(text)
	})
})
