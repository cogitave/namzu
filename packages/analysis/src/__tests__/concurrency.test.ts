import { execFile } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../__fixtures__/refresh.mjs', import.meta.url))

const trees: Tree[] = []
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

function bigTree(): Tree {
	const files: Record<string, string> = {}
	for (let i = 0; i < 60; i++)
		files[`f${i}.js`] = `function f${i}(){ return "shared-needle-${i}" }\n`
	const tree = new Tree(files)
	trees.push(tree)
	return tree
}

describe('several processes indexing one root into one cache', () => {
	it('all succeed, store each file once, and keep the substring index', async () => {
		const tree = bigTree()
		const cache = new Tree()
		trees.push(cache)

		const runs = await Promise.all(
			Array.from({ length: 4 }, () =>
				run(process.execPath, [SCRIPT, tree.root, cache.root, 'shared-needle']),
			),
		)
		for (const r of runs) {
			const line = JSON.parse(r.stdout.trim().split('\n').pop() as string)
			expect(line.indexed).toBe(60)
			expect(line.hits).toBe(60)
		}

		const files = readdirSync(cache.root).filter((f) => f.endsWith('.sqlite'))
		expect(files).toHaveLength(1)
		const { DatabaseSync } = await import('node:sqlite')
		const db = new DatabaseSync(join(cache.root, files[0] as string), { readOnly: true })
		const dup = db
			.prepare(
				'SELECT count(*) AS n FROM (SELECT path FROM files GROUP BY path HAVING count(*) > 1)',
			)
			.get() as { n: number }
		const ids = db
			.prepare('SELECT count(*) AS n, count(DISTINCT id) AS d FROM functions')
			.get() as { n: number; d: number }
		const fts = db.prepare("SELECT value FROM meta WHERE key = 'fts'").get() as { value: string }
		db.close()
		expect(dup.n).toBe(0)
		expect(ids.n).toBe(ids.d)
		// This Node has FTS5 (CI runs 22.20 and 24): a busy database must not
		// make the capability probe decide it does not.
		expect(fts.value).toBe('1')
	}, 120_000)

	it("a second provider in this process sees the first one's work", async () => {
		const tree = bigTree()
		const cache = new Tree()
		trees.push(cache)
		const one = provider({ cacheDir: cache.root })
		const two = provider({ cacheDir: cache.root })
		const [a, b] = await Promise.all([
			one.index({ root: tree.root }),
			two.index({ root: tree.root }),
		])
		expect(ok(a).value.files.indexed).toBe(60)
		expect(ok(b).value.files.indexed).toBe(60)
		await one.dispose()
		await two.dispose()
	}, 60_000)
})
