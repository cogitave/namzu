import { describe, expect, it } from 'vitest'
import { directoryOf, prepareIndex, searchFiles, segmentsOf } from './file-search.js'

const index = prepareIndex([
	'docs/2026-07-28-design-system.md',
	'docs/decisions/adr-1.md',
	'src/renderer/app.tsx',
	'README.md',
])

describe('file search', () => {
	it('ranks the file name match first and marks matched characters', () => {
		const hits = searchFiles(index, 'app')
		expect(hits[0]?.path).toBe('src/renderer/app.tsx')
		expect(
			hits[0]?.segments
				.filter((s) => s.match)
				.map((s) => s.text)
				.join(''),
		).toBe('app')
	})
	it('returns the head of the index for an empty query', () => {
		expect(searchFiles(index, '  ', 2).map((hit) => hit.path)).toEqual([
			'docs/2026-07-28-design-system.md',
			'docs/decisions/adr-1.md',
		])
	})
	it('returns nothing when nothing matches', () => {
		expect(searchFiles(index, 'zzzqqq')).toEqual([])
	})
	it('splits a target into runs without losing characters', () => {
		const segments = segmentsOf('abcdef', [1, 2, 4])
		expect(segments).toEqual([
			{ text: 'a', match: false },
			{ text: 'bc', match: true },
			{ text: 'd', match: false },
			{ text: 'e', match: true },
			{ text: 'f', match: false },
		])
		expect(directoryOf('a/b/c.md')).toBe('a/b')
		expect(directoryOf('c.md')).toBe('')
	})
})
