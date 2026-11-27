import { describe, expect, it } from 'vitest'

import {
	SKILL_BODY_MAX_BYTES,
	SkillDraftError,
	hasMarkupTags,
	suggestSkillName,
	validateSkillDescription,
	validateSkillDraft,
	validateSkillName,
} from './validate.js'

describe('the shared skill validators', () => {
	it('suggests a name from free text', () => {
		expect(suggestSkillName('Weekly Status')).toBe('weekly-status')
		expect(suggestSkillName('  Çalışma Raporu!! ')).toBe('calisma-raporu')
		expect(suggestSkillName('***')).toBe('')
		expect(suggestSkillName('a'.repeat(80)).length).toBe(64)
	})

	it('accepts and refuses names by the loader pattern', () => {
		expect(validateSkillName(' release-notes ')).toBe('release-notes')
		for (const bad of ['', 'Release', 'a--b', '-a', 'a_b', 'a'.repeat(65)]) {
			expect(() => validateSkillName(bad)).toThrow(SkillDraftError)
		}
	})

	it('finds tag-like text and leaves comparisons alone', () => {
		expect(hasMarkupTags('use <b>this</b>')).toBe(true)
		expect(hasMarkupTags('a </x> b')).toBe(true)
		expect(hasMarkupTags('when a < b and b > c')).toBe(false)
		expect(hasMarkupTags('1 <3 you')).toBe(false)
	})

	it('refuses tags only when asked, so save_skill keeps its behaviour', () => {
		expect(validateSkillDescription('Use <b> sparingly')).toBe('Use <b> sparingly')
		expect(() => validateSkillDescription('Use <b> sparingly', { rejectMarkup: true })).toThrow(
			/tags/,
		)
	})

	it('limits the description and the body', () => {
		expect(() => validateSkillDescription('x'.repeat(1025))).toThrow(/at most 1024/)
		expect(validateSkillDescription('x'.repeat(1024))).toHaveLength(1024)
		expect(() =>
			validateSkillDraft({
				name: 'a',
				description: 'd',
				body: 'x'.repeat(SKILL_BODY_MAX_BYTES + 1),
			}),
		).toThrow(/at most 65536/)
		expect(() =>
			validateSkillDraft({ name: 'a', description: 'd', body: '---\nx\n---\nbody' }),
		).toThrow(/instructions only/)
	})
})
