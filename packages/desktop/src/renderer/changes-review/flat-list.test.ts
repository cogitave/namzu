import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FlatFileList, listNames } from './flat-list.js'
import { FLAT_LIST_LIMIT, largestFile } from './model.js'

const file = (path: string, added: number, removed = 0) => ({
	path,
	added,
	removed,
	status: 'modified' as const,
})

describe('the narrow file list', () => {
	it('opens on the file that changed most, the first of equals', () => {
		expect(largestFile([file('a.ts', 2), file('b.ts', 19), file('c.ts', 8)])?.path).toBe('b.ts')
		expect(largestFile([file('a.ts', 3, 1), file('b.ts', 2, 2)])?.path).toBe('a.ts')
		expect(largestFile([])).toBeUndefined()
	})
	it('names a file by its name and adds the folder only where two share one', () => {
		const names = listNames([
			file('src/a/index.ts', 1),
			file('src/b/index.ts', 1),
			file('x/main.ts', 1),
		])
		expect(names.get('src/a/index.ts')).toBe('index.ts · src/a')
		expect(names.get('x/main.ts')).toBe('main.ts')
	})
	it('marks the open file and carries its counts', () => {
		const html = renderToStaticMarkup(
			createElement(FlatFileList, {
				files: [file('src/a.ts', 19), file('b.ts', 3, 1)],
				selected: 'b.ts',
				onSelect: () => {},
			}),
		)
		expect(html).toContain('+19')
		expect(html).toContain('−1')
		expect(html.match(/aria-current="true"/g)).toHaveLength(1)
		expect(FLAT_LIST_LIMIT).toBeGreaterThan(4)
	})
})
