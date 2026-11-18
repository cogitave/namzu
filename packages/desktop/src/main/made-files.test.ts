import { describe, expect, it } from 'vitest'
import { type FolderReader, madeBetween, snapshotFolder } from './made-files.js'

function reader(tree: Record<string, string[] | { size: number; modified: number }>): FolderReader {
	return {
		async list(dir) {
			const entry = tree[dir]
			if (!Array.isArray(entry)) throw new Error('not a folder')
			return entry.map((name) => {
				const path = `${dir}/${name}`
				const child = tree[path]
				return { name, directory: Array.isArray(child), file: !Array.isArray(child) }
			})
		},
		async stat(path) {
			const entry = tree[path]
			return entry && !Array.isArray(entry) ? entry : undefined
		},
	}
}

describe('listing result files', () => {
	const tree = {
		'/w': ['a.md', 'src', '.git', 'node_modules', 'notes.log', 'chart.png', '.hidden.md'],
		'/w/src': ['app.ts', 'out.html'],
		'/w/.git': ['x.md'],
		'/w/node_modules': ['y.md'],
		'/w/a.md': { size: 5, modified: 1 },
		'/w/notes.log': { size: 5, modified: 1 },
		'/w/chart.png': { size: 9, modified: 2 },
		'/w/.hidden.md': { size: 1, modified: 1 },
		'/w/src/app.ts': { size: 5, modified: 1 },
		'/w/src/out.html': { size: 7, modified: 3 },
	}
	it('keeps results only, and never enters tool folders', async () => {
		const found = await snapshotFolder('/w', reader(tree))
		expect([...found.keys()].sort()).toEqual(['/w/a.md', '/w/chart.png', '/w/src/out.html'])
	})
	it('stops at the depth and the count it was given', async () => {
		expect((await snapshotFolder('/w', reader(tree), { depth: 0 })).has('/w/src/out.html')).toBe(
			false,
		)
		expect((await snapshotFolder('/w', reader(tree), { entries: 2 })).size).toBeLessThanOrEqual(2)
	})
	it('reports what is new or changed, oldest first', async () => {
		const before = await snapshotFolder('/w', reader(tree))
		const after = new Map(before)
		after.set('/w/a.md', { size: 6, modified: 4 })
		after.set('/w/new.pdf', { size: 1, modified: 5 })
		after.delete('/w/chart.png')
		expect(madeBetween(before, after).map((file) => file.path)).toEqual(['/w/a.md', '/w/new.pdf'])
	})
	it('answers nothing for a folder it cannot read', async () => {
		expect((await snapshotFolder('/nowhere', reader({}))).size).toBe(0)
	})
})
