import { describe, expect, it } from 'vitest'

import { FORM_OPTATIVE, FORM_POLITE, PatternError, compilePattern, matchAt } from './pattern.js'

const words = (text: string) => text.split(' ')

describe('the phrase language', () => {
	it('matches words, alternatives, optionals, numbers and apostrophe suffixes', () => {
		const pattern = compilePattern("[please] run (this|it) every <n> (minutes|hours) [skill+']")
		expect(matchAt(pattern, words('run it every 5 minutes'), 0)[0]).toEqual({
			start: 0,
			end: 5,
			flags: 0,
		})
		expect(matchAt(pattern, words('please run this every 10 hours'), 0)[0]?.end).toBe(6)
		expect(matchAt(pattern, words("run it every 5 minutes skill'e"), 0)[0]?.end).toBe(6)
		expect(matchAt(pattern, words('run it every five minutes'), 0)).toEqual([])
	})

	it('carries a verb form’s flags and takes a question particle after it', () => {
		const pattern = compilePattern('skill olarak {kaydet}')
		expect(matchAt(pattern, words('skill olarak kaydeder misin'), 0)[0]).toEqual({
			start: 0,
			end: 4,
			flags: FORM_POLITE,
		})
		expect(matchAt(pattern, words('skill olarak kaydedelim mi'), 0)[0]).toEqual({
			start: 0,
			end: 4,
			flags: FORM_OPTATIVE,
		})
	})

	it('refuses a pattern it cannot read, naming it', () => {
		for (const bad of ['(a|b', 'a ]', '[', '{kaydet', 'a (|b)', 'a.b']) {
			expect(() => compilePattern(bad), bad).toThrow(PatternError)
		}
		expect(() => compilePattern('{uçur}')).toThrow('No verb table entry')
	})
})
