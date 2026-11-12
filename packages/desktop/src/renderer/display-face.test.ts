import { describe, expect, it } from 'vitest'
import { displayFaceCovers, displayFaceText } from './display-face.js'

// A project folder can be named with any characters. The name is drawn in the display face only
// when every character is in that face; one character outside it keeps the whole name in the
// interface face.

describe('displayFaceCovers', () => {
	it('draws plain ASCII names', () => {
		for (const name of ['harbor-api', 'Namzu', 'my_project.v2', 'app 2024', 'a']) {
			expect(displayFaceCovers(name), name).toBe(true)
		}
	})

	it('draws Turkish names, dotted and dotless i included', () => {
		for (const name of ['çağrı-işleme', 'IŞIK', 'İstanbul', 'ığdır', 'ÖĞRENCİ', 'şükrü']) {
			expect(displayFaceCovers(name), name).toBe(true)
		}
	})

	it('keeps a name with a Cyrillic or CJK character in the interface face', () => {
		for (const name of ['проект', 'harbor-проект', '日本語', 'api-中', 'aЖ']) {
			expect(displayFaceCovers(name), name).toBe(false)
		}
	})

	it('keeps a name with an emoji in the interface face', () => {
		for (const name of ['rocket 🚀', '😀', 'a\u{1F680}b']) {
			expect(displayFaceCovers(name), name).toBe(false)
		}
	})

	it('judges combining marks as the composed text, and refuses a mark the face lacks', () => {
		// Base letter plus a combining cedilla or dot above is the composed letter the face has.
		expect(displayFaceCovers('çağri')).toBe(true)
		expect(displayFaceText('ç')).toBe('ç')
		// A combining mark the face has no glyph for, alone or after a letter, keeps the name out.
		expect(displayFaceCovers('aͅ')).toBe(false)
		expect(displayFaceCovers('́ͅ')).toBe(false)
		// Zero-width joiners and variation selectors are not in the face.
		expect(displayFaceCovers('a‍b')).toBe(false)
		expect(displayFaceCovers('a️')).toBe(false)
	})

	it('keeps an empty name, and control characters, out', () => {
		expect(displayFaceCovers('')).toBe(false)
		expect(displayFaceCovers('line\nbreak')).toBe(false)
		expect(displayFaceCovers('tab\there')).toBe(false)
	})

	it('returns the composed text it judged, never a mix', () => {
		expect(displayFaceText('harbor-api')).toBe('harbor-api')
		expect(displayFaceText('harbor-проект')).toBeUndefined()
	})
})
