import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { fold, foldWithMap } from './fold.js'
import { BUILTIN_TRIGGERS } from './registry.js'

describe('folding', () => {
	it.each([
		['İSTANBUL', 'istanbul'],
		['KAYDET', 'kaydet'],
		['ÇALIŞTIR', 'calistir'],
		['ıspanak', 'ispanak'],
		['Kaydét', 'kaydet'],
		['skill’e', "skill'e"],
		['‘quoted’', "'quoted'"],
	])('%s → %s', (source, folded) => {
		expect(fold(source)).toBe(folded)
	})

	it('maps every folded character back to the grapheme it came from', () => {
		// Decomposed letters, a dotted capital I, a dotless i, and a ZWJ family.
		const source = 'Káydet İyi ılık 👨‍👩‍👧 son'
		const { text, map } = foldWithMap(source)
		expect(map).toHaveLength(text.length + 1)
		expect(map[text.length]).toBe(source.length)
		// Each folded word maps back to the source word it came from.
		for (const word of ['kaydet', 'iyi', 'ilik', 'son']) {
			const at = text.indexOf(word)
			expect(at, word).toBeGreaterThanOrEqual(0)
			const back = source.slice(map[at], map[at + word.length])
			expect(fold(back)).toBe(word)
		}
		// Offsets never go backwards.
		for (let index = 1; index < map.length; index += 1) {
			expect(map[index]).toBeGreaterThanOrEqual(map[index - 1] ?? 0)
		}
	})

	it('merges different words, so no built-in phrase word may fold onto another common word', () => {
		// The claim that folding keeps words apart is false: these pairs merge.
		expect(fold('sık')).toBe(fold('sik'))
		expect(fold('düş')).toBe(fold('duş'))
		expect(fold('aşı')).toBe(fold('ası'))
		expect(fold('şişe')).toBe(fold('sise'))
		const words = readFileSync(join(import.meta.dirname, '__fixtures__', 'tr-words.txt'), 'utf8')
			.split('\n')
			.filter((line) => !line.startsWith('#'))
			.flatMap((line) => line.split(/\s+/u))
			.filter(Boolean)
		const phraseWords = new Set<string>()
		for (const trigger of BUILTIN_TRIGGERS) {
			for (const spec of Object.values(trigger.phrases).flat()) {
				for (const word of spec?.pattern.match(/[\p{L}]+/gu) ?? [])
					phraseWords.add(word.toLocaleLowerCase('tr'))
			}
		}
		const collisions = [...phraseWords].flatMap((word) =>
			words
				.filter((other) => other.toLocaleLowerCase('tr') !== word && fold(other) === fold(word))
				.map((other) => `${word} ~ ${other}`),
		)
		expect(collisions).toEqual([])
	})
})
