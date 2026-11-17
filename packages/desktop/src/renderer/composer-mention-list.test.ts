import { describe, expect, it } from 'vitest'
import { type MentionIndex, mentionList, nameSegments } from './composer-mention-list.js'
import { prepareIndex } from './file-panel/file-search.js'

const ready = (paths: string[], truncated = false): MentionIndex => ({
	state: 'ready',
	index: prepareIndex(paths),
	truncated,
})

describe('mentionList', () => {
	it('waits while the list loads and opens nothing when it failed', () => {
		expect(mentionList({ state: 'loading' }, 'a')).toEqual({ kind: 'loading' })
		expect(mentionList({ state: 'failed' }, 'a')).toEqual({ kind: 'closed' })
	})

	it('lists the first eight paths for an empty query', () => {
		const paths = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`)
		const list = mentionList(ready(paths), '')
		expect(list.kind === 'rows' && list.rows.map((r) => r.path)).toEqual(paths.slice(0, 8))
	})

	it('finds files by their letters and splits the name from its folder', () => {
		const list = mentionList(ready(['docs/readme.md', 'public/index.html']), 'ind')
		expect(list.kind).toBe('rows')
		if (list.kind !== 'rows') return
		expect(list.rows).toHaveLength(1)
		const row = list.rows[0]
		expect(row?.name).toBe('index.html')
		expect(row?.directory).toBe('public')
		const strong = row
			? nameSegments(row)
					.filter((s) => s.match)
					.map((s) => s.text)
			: []
		expect(strong.join('')).toBe('ind')
	})

	it('closes when nothing matches and says so when the project is only partly listed', () => {
		expect(mentionList(ready(['a.ts']), 'zzzz')).toEqual({ kind: 'closed' })
		const list = mentionList(ready(['a.ts'], true), 'a')
		expect(list.kind === 'rows' && list.note).toMatch(/large project/)
	})
})
