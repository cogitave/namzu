import { describe, expect, it } from 'vitest'
import { shortenTitle } from './short-title.js'

describe('shortenTitle', () => {
	it('leaves a title that fits alone', () => {
		expect(shortenTitle('Merhaba dünya', 26)).toBe('Merhaba dünya')
	})
	it('cuts at a word boundary, not in the middle of a word', () => {
		expect(shortenTitle('Bu eki ekledim, lütfen dosya oluştur', 26)).toBe('Bu eki ekledim, lütfen…')
		expect(shortenTitle('İstanbul Şubesi için yeni rapor taslağı', 26)).toBe(
			'İstanbul Şubesi için yeni…',
		)
	})
	it('cuts a single long word where it must', () => {
		expect(shortenTitle('a'.repeat(40), 10)).toBe(`${'a'.repeat(10)}…`)
	})
	it('does not split a character made of two code units', () => {
		expect(shortenTitle('😀'.repeat(30), 5)).toBe(`${'😀'.repeat(5)}…`)
	})
})
