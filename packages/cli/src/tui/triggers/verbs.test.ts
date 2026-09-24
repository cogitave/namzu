import { describe, expect, it } from 'vitest'

import { fold } from './fold.js'
import { VERB_NAMES, verbForms } from './verbs.js'

const spelled = (verb: string) => verbForms(verb).map((form) => form.tokens.join(' '))

describe('the Turkish verb table', () => {
	it('accepts the request forms people type', () => {
		expect(spelled('kaydet')).toEqual(
			expect.arrayContaining([
				'kaydet',
				'kaydedin',
				'kaydediniz',
				'kaydedelim',
				'kaydeder misin',
				'kaydeder misiniz',
				'kaydedermisin',
				'kaydedebilir misin',
				'kaydedebilir misiniz',
				'kaydedebilirmisin',
				'kaydetsene',
				'kaydetsenize',
				'kaydetsen',
			]),
		)
		expect(spelled('dönüştür')).toEqual(
			expect.arrayContaining(['donusturur musun', 'donusturur musunuz']),
		)
		expect(spelled('yap')).toEqual(
			expect.arrayContaining(['yapar misin', 'yapalim', 'yapsana', 'yapsaniza']),
		)
	})

	it('never contains a negative form, so a phrase cannot match one', () => {
		const negatives = [
			'kaydetme',
			'kaydetmeyin',
			'kaydetmeden',
			'kaydetmesin',
			'yapma',
			'yapmayin',
			'cevirme',
		]
		for (const verb of VERB_NAMES) {
			for (const form of verbForms(verb)) {
				for (const token of form.tokens) {
					expect(negatives, `${verb}: ${token}`).not.toContain(token)
					// A negative stem is the verb plus -me/-ma.
					expect(
						token.startsWith(`${fold(verb)}me`) || token.startsWith(`${fold(verb)}ma`),
						token,
					).toBe(false)
				}
			}
		}
	})

	it('marks the polite questions and the "let\'s" form', () => {
		const forms = verbForms('kaydet')
		expect(forms.find((form) => form.tokens.join(' ') === 'kaydeder misin')?.polite).toBe(true)
		expect(forms.find((form) => form.tokens.join(' ') === 'kaydedelim')?.optative).toBe(true)
		expect(forms.find((form) => form.tokens.join(' ') === 'kaydet')?.polite).toBe(false)
	})

	it('refuses a verb it does not have', () => {
		expect(() => verbForms('uçur')).toThrow('No verb table entry')
	})
})
