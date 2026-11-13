import { readFileSync } from 'node:fs'
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

describe('a long name in the flat list', () => {
	const css = readFileSync(new URL('./review.css', import.meta.url), 'utf8')
	const rule = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`)
		return css.slice(start, css.indexOf('}', start))
	}
	it('is never cut before its folder is', () => {
		// The folder is what shrinks (a huge shrink factor); the name keeps its width until the folder is gone.
		expect(rule('.changes-flat-folder')).toMatch(/flex:\s*1 10000 0/)
		expect(rule('.changes-flat-folder')).toMatch(/text-overflow:\s*ellipsis/)
		expect(rule('.changes-flat-name')).toMatch(/flex:\s*0 1 auto/)
		// Cut at last, it is cut at its start, so the end of a long name stays readable.
		expect(rule('.changes-flat-name')).toMatch(/direction:\s*rtl/)
		expect(rule('.changes-diff-path')).toMatch(/direction:\s*rtl/)
	})
	it('shows the folder beside the name only where two files share a name', () => {
		const html = renderToStaticMarkup(
			createElement(FlatFileList, {
				files: [file('src/a/index.ts', 1), file('src/b/index.ts', 1), file('x/main.ts', 1)],
				onSelect: () => {},
			}),
		)
		expect(html.match(/changes-flat-folder/g)).toHaveLength(2)
		expect(html).toContain('<span class="changes-flat-folder">src/a</span>')
		expect(html).not.toContain('>x</span>')
	})
})
