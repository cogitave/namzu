import { describe, expect, it } from 'vitest'
import { foldSearchText, foldedIncludes } from './text-fold.js'

describe('foldSearchText', () => {
	it('treats I, ı, İ and i as one letter', () => {
		for (const query of ['ışık', 'Işık', 'IŞIK', 'isik', 'ISIK', 'İŞİK']) {
			expect(foldedIncludes('Işık raporu', query)).toBe(true)
			expect(foldedIncludes('ışık ölçümü', query)).toBe(true)
		}
	})
	it('folds Turkish accents and finds İpek from IPEK', () => {
		expect(foldedIncludes('İpek yolu', 'IPEK')).toBe(true)
		expect(foldedIncludes('Şeker', 'seker')).toBe(true)
		expect(foldedIncludes('Ağaç', 'AGAC')).toBe(true)
	})
	it('keeps English capitals matching', () => {
		expect(foldSearchText('SETTINGS TERMINAL')).toBe('settings terminal')
	})
	it('does not match unrelated text', () => {
		expect(foldedIncludes('Işık raporu', 'zzz')).toBe(false)
	})
})
