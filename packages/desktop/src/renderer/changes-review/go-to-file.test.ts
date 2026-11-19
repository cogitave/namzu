import { describe, expect, it } from 'vitest'
import { GO_TO_LIMIT, goToFileRows } from './go-to-file.js'

describe('Go to file', () => {
	const paths = ['src/app.ts', 'src/rail.css', 'docs/readme.md']
	it('lists every file for no query and only matches for a query', () => {
		expect(goToFileRows(paths, '').rows.map((row) => row.path)).toEqual(paths)
		expect(goToFileRows(paths, 'rail').rows.map((row) => row.path)).toEqual(['src/rail.css'])
		expect(goToFileRows(paths, 'zzzz')).toEqual({ rows: [], more: 0 })
	})

	it('caps the rows at a hundred and says how many more there are', () => {
		const many = Array.from({ length: GO_TO_LIMIT + 7 }, (_, index) => `f/file${index}.ts`)
		const { rows, more } = goToFileRows(many, '')
		expect(rows).toHaveLength(GO_TO_LIMIT)
		expect(more).toBe(7)
	})
})
