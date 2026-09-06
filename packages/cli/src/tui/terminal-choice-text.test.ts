import { expect, it } from 'vitest'

import {
	choiceDisplayText,
	choiceDisplayWidth,
	eraseLastChoiceGrapheme,
	truncateChoiceText,
} from './terminal-choice-text.js'

it('erases a complete query grapheme without changing its preceding source bytes', () => {
	for (const suffix of ['e\u0301', '👩‍💻', '🇹🇷', '界']) {
		expect(eraseLastChoiceGrapheme(`before${suffix}`)).toBe('before')
	}
	expect(eraseLastChoiceGrapheme('')).toBe('')
	expect(eraseLastChoiceGrapheme('x')).toBe('')
})

it('measures terminal cells and truncates only at whole grapheme boundaries', () => {
	expect(choiceDisplayWidth('界e\u0301👩‍💻')).toBe(5)
	expect(truncateChoiceText('界e\u0301👩‍💻 next', 5)).toBe('界e\u0301…')
	expect(truncateChoiceText('👩‍💻abc', 3)).toBe('👩‍💻…')
	expect(truncateChoiceText('🇹🇷abc', 3)).toBe('🇹🇷…')
	expect(truncateChoiceText('e\u0301abc', 2)).toBe('e\u0301…')
	expect(truncateChoiceText('界', 0)).toBe('')
	expect(truncateChoiceText('界', 1)).toBe('…')
})

it('projects controls and multiline tool text into a single safe menu row', () => {
	expect(choiceDisplayText('release\nbranch\tname\x1b')).toBe('release branch name\\u{001b}')
	expect(choiceDisplayWidth('a\nb')).toBe(3)
	expect(truncateChoiceText('A\x1bB', 20)).toBe('A\\u{001b}B')
})
