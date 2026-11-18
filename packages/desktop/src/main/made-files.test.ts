import { describe, expect, it } from 'vitest'
import {
	type FolderReader,
	madeBetween,
	madeSince,
	scanFolder,
	snapshotFolder,
} from './made-files.js'

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
	it('keeps only files written during the turn, not a listing taken after it began', async () => {
		const found = await snapshotFolder('/w', reader(tree))
		// Times 1, 2 and 3; a turn that began at 2003 allows 2000 of slack, so only time 3 is in.
		expect(madeSince(found, 2003).map((file) => file.path)).toEqual(['/w/src/out.html'])
		expect(madeSince(found, 5000).map((file) => file.path)).toEqual([])
		expect(madeSince(found, 0).map((file) => file.path)).toHaveLength(3)
	})
	it('counts only result files toward the limit and walks names in order', async () => {
		const names = ['z.ts', 'y.ts', 'x.ts', 'b.md', 'a.md']
		const flat = {
			'/w': names,
			...Object.fromEntries(names.map((name) => [`/w/${name}`, { size: 1, modified: 1 }])),
		}
		const scan = await scanFolder('/w', reader(flat), { entries: 2 })
		expect(scan.complete).toBe(true)
		expect([...scan.files.keys()]).toEqual(['/w/a.md', '/w/b.md'])
		expect((await scanFolder('/w', reader(flat), { entries: 1 })).complete).toBe(false)
	})
	it('says so when the folder limit cut the walk short', async () => {
		expect((await scanFolder('/w', reader(tree), { folders: 1 })).complete).toBe(false)
	})
})
