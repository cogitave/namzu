import { afterEach, describe, expect, it } from 'vitest'

import { Files, StaleIndexError } from '../context.js'
import { type FileRecord, Store } from '../store.js'
import { EMPTY_ROWS } from '../walk.js'
import { Tree } from './helpers.js'

const trees: Tree[] = []
const stores: Store[] = []
afterEach(() => {
	for (const s of stores.splice(0)) s.close()
	for (const t of trees.splice(0)) t.dispose()
})

function record(hash: string, path = 'a.js'): FileRecord {
	return {
		path,
		chars: 20,
		lang: 'js',
		parseErrors: 0,
		degraded: 0,
		lineStarts: new Uint32Array([0]),
		size: 20,
		mtimeMs: 1000,
		hash,
		rows: {
			...EMPTY_ROWS,
			strings: [
				{
					fnId: null,
					start: 0,
					end: 5,
					kind: 'string',
					value: 'needle-value',
					cut: 0,
				},
			],
		},
	}
}

/** Two connections to one cache file, as two processes indexing one root have. */
async function twoConnections(): Promise<{ a: Store; b: Store; root: string }> {
	const tree = new Tree()
	const cache = new Tree()
	trees.push(tree, cache)
	const a = (await Store.open(tree.root, cache.root)) as Store
	const b = (await Store.open(tree.root, cache.root)) as Store
	stores.push(a, b)
	return { a, b, root: tree.root }
}

function write(store: Store, rec: FileRecord): void {
	store.exec('BEGIN IMMEDIATE')
	store.writeFile(rec)
	store.exec('COMMIT')
}

describe('concurrent indexers and readers of one cache', () => {
	it('a second indexer storing identical content keeps the first one’s file rows', async () => {
		const { a, b } = await twoConnections()
		write(a, record('h1'))
		write(a, record('h1', 'z.js'))
		const first = a.get('SELECT id FROM files WHERE path = ?', 'a.js')?.id
		write(b, record('h1'))
		expect(b.get('SELECT id FROM files WHERE path = ?', 'a.js')?.id).toBe(first)
		expect(b.get('SELECT count(*) AS n FROM strings')?.n).toBe(2)
		// Changed content still replaces the rows.
		write(b, record('h2'))
		expect(b.get('SELECT id FROM files WHERE path = ?', 'a.js')?.id).not.toBe(first)
		expect(b.get('SELECT count(*) AS n FROM strings')?.n).toBe(2)
	})

	it('a read snapshot resolves every file its rows name, even if another writer replaces them meanwhile', async () => {
		const { a, b, root } = await twoConnections()
		write(a, record('h1'))
		write(a, record('h1', 'z.js'))
		const files = new Files(a, root)

		const ids = a.snapshot(() => {
			const rows = a.all(
				"SELECT s.file_id FROM strings s JOIN files f ON f.id = s.file_id WHERE f.path = 'a.js'",
			)
			// Another process re-indexes the file in the middle of the read.
			write(b, record('h2'))
			const fileIds = rows.map((r) => Number(r.file_id))
			files.preload(fileIds)
			return fileIds
		})

		expect(ids).toHaveLength(1)
		expect(files.byIdOrThrow(ids[0] as number).rel).toBe('a.js')
		// Outside the snapshot the old id is gone, which is what readers used to trip over.
		const fresh = new Files(a, root)
		expect(() => fresh.byIdOrThrow(ids[0] as number)).toThrow(StaleIndexError)
	})
})
