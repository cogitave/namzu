import { describe, expect, it } from 'vitest'
import { fitTitle } from './fit-title.js'

// One unit per character keeps the cases readable.
const width = (text: string) => [...text].length

describe('fitTitle', () => {
	it('keeps the whole text when it fits', () => {
		expect(fitTitle(['sh 7 · project'], 20, width)).toBe('sh 7 · project')
	})
	it('drops the project suffix before touching the distinguishing part', () => {
		expect(fitTitle(['sh 7 · project', 'sh 7'], 8, width)).toBe('sh 7')
		expect(fitTitle(['sh 12 · project', 'sh 12'], 6, width)).toBe('sh 12')
	})
	it('cuts a long title after a whole word, using the room it has', () => {
		const title = 'Bu eki ekledim, lütfen dosya oluştur'
		expect(fitTitle([title], 24, width)).toBe('Bu eki ekledim, lütfen…')
		expect(fitTitle([title], 22, width)).toBe('Bu eki ekledim…')
	})
	it('cuts inside a word when the only boundary would leave less than half the room', () => {
		expect(fitTitle(['New conversation'], 10, width)).toBe('New conve…')
	})
	it('cuts a single long word only when it must, and never splits a letter', () => {
		expect(fitTitle(['İstanbul’daki'], 5, width)).toBe('İsta…')
		expect(fitTitle(['😀😀😀😀'], 3, width)).toBe('😀😀…')
	})
	it('shows only the ellipsis when there is no room at all', () => {
		expect(fitTitle(['abc'], 0, width)).toBe('…')
		expect(fitTitle([], 10, width)).toBe('')
	})
})
