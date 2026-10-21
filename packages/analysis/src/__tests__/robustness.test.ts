import { readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ParserHost } from '../host.js'
import { refreshIndex } from '../indexer.js'
import { Store } from '../store.js'
import { Tree, failure, locate, ok, provider } from './helpers.js'

const trees: Tree[] = []
const make = (files: Record<string, string | Uint8Array> = {}) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const T0 = 1_700_000_000

describe('cancelling', () => {
	it('answers a cancelled call as cancelled, not as an empty result, and starts nothing', async () => {
		const tree = make({ 'a.js': 'function a(){ return "never-indexed" }' })
		const p = provider()
		const controller = new AbortController()
		const reply = p.findLiteral({
			root: tree.root,
			text: 'never-indexed',
			signal: controller.signal,
		})
		controller.abort()
		expect(failure(await reply)).toContain('cancelled')
		// The aborted call did not build the index behind the caller's back.
		const later = ok(await p.findLiteral({ root: tree.root, text: 'never-indexed' }))
		expect(later.evidence.observed.join(' ')).toContain('was built for this call')
		await p.dispose()
	})

	it('keeps what an interrupted index had committed and continues from there', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 6; i++) files[`f${i}.js`] = `function f${i}(){ return ${i} }\n`
		const tree = make(files)
		const cache = make()
		const store = (await Store.open(tree.root, cache.root)) as Store
		const controller = new AbortController()
		const real = new ParserHost()
		let calls = 0
		// The third parse is where the user presses Esc.
		const host = {
			parse: async (job: { rel: string; abs: string; text: string }, signal?: AbortSignal) => {
				if (++calls === 3) controller.abort()
				return await real.parse(job, signal)
			},
			kill: () => real.kill(),
		} as unknown as ParserHost
		const options = {
			ignoreDirs: [],
			maxFileBytes: 1e8,
			maxFiles: 1e6,
			maxDirectories: 1e6,
			maxMillis: 1e9,
			force: false,
		}
		await expect(
			store.run(() => refreshIndex(store, tree.root, tree.root, options, host, controller.signal)),
		).rejects.toMatchObject({ name: 'AbortError' })
		const kept = Number((store.get('SELECT count(*) AS n FROM files') as { n: number }).n)
		expect(kept).toBeGreaterThanOrEqual(1)
		expect(kept).toBeLessThan(6)
		// Not marked covered, so the next call carries on.
		expect(store.meta('covered')).toBe('[]')
		const resumed = await store.run(() => refreshIndex(store, tree.root, tree.root, options, real))
		expect(resumed.indexed).toBe(6)
		expect(resumed.unchanged).toBe(kept)
		real.kill()
		store.close()
	})

	it('kills the parsing child on abort and parses again with a fresh one', async () => {
		const host = new ParserHost()
		const controller = new AbortController()
		controller.abort()
		await expect(
			host.parse({ rel: 'a.js', abs: '/x/a.js', text: 'var a = 1' }, controller.signal),
		).rejects.toMatchObject({ name: 'AbortError' })
		const again = await host.parse({ rel: 'b.js', abs: '/x/b.js', text: 'function b(){}' })
		expect(again.kind).toBe('rows')
		host.kill()
	})
})

describe('a root too big to index whole', () => {
	function wide(): Tree {
		const files: Record<string, string> = {}
		for (let d = 0; d < 10; d++) files[`d${d}/m.js`] = `function m${d}(){ return "lit-${d}" }\n`
		return make(files)
	}

	it('stops at the directory limit, answers from what it has, and says how to go on', async () => {
		const tree = wide()
		const p = provider({ maxDirectories: 3 })
		const out = ok(await p.index({ root: tree.root }))
		expect(out.value.truncated).toMatch(/3 directories/)
		expect(out.value.truncated).toContain('narrower path')
		expect(out.value.files.indexed).toBeGreaterThan(0)
		expect(out.value.files.indexed).toBeLessThan(10)
		expect(out.evidence.coverage.status).toBe('partial')

		// A query is not refused; it answers from the partial index and says so.
		const hit = ok(await p.findLiteral({ root: tree.root, text: 'lit-0' }))
		expect(hit.value.total).toBe(1)
		expect(JSON.stringify(hit.evidence.coverage)).toContain('narrower path')
		// And it does not spend the limit again on every question.
		expect(hit.evidence.observed.join(' ')).not.toContain('was built for this call')

		// The next step works: index a narrower path and the rest of it answers.
		const missing = ok(await p.findLiteral({ root: tree.root, text: 'lit-9' })).value.total
		expect(missing).toBe(0)
		ok(await p.index({ root: tree.root, scope: join(tree.root, 'd9') }))
		expect(ok(await p.findLiteral({ root: tree.root, text: 'lit-9' })).value.total).toBe(1)
		await p.dispose()
	})

	it('stops at the time limit the same way, never as a refusal', async () => {
		const tree = wide()
		const p = provider({ maxMillis: 0 })
		const out = await p.index({ root: tree.root })
		expect(out.kind).toBe('ok')
		expect(ok(out).value.truncated).toMatch(/seconds/)
		expect(ok(out).evidence.coverage.status).toBe('partial')
		const query = await p.findLiteral({ root: tree.root, text: 'lit-1' })
		expect(query.kind).toBe('ok')
		await p.dispose()
	})

	it('indexes just a file or directory on request, and a query about it builds only that', async () => {
		const tree = wide()
		const p = provider()
		const hit = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('d4/m.js'),
				line: 1,
				column: 25,
			}),
		)
		expect(hit.value.function?.name).toBe('m4')
		const summary = ok(await p.index({ root: tree.root, scope: tree.path('d5') }))
		// Two files: the one the query asked for and this directory's.
		expect(summary.value.files.indexed).toBe(2)
		await p.dispose()
	})
})

describe('a busy or damaged cache', () => {
	it('is waited out, never deleted, while another connection holds the write lock', async () => {
		const tree = make({ 'a.js': 'function a(){ return "locked-literal" }\n' })
		const cache = make()
		const one = provider({ cacheDir: cache.root })
		ok(await one.index({ root: tree.root }))
		await one.dispose()
		const file = readdirSync(cache.root).find((f) => f.endsWith('.sqlite')) as string

		const { DatabaseSync } = await import('node:sqlite')
		const holder = new DatabaseSync(join(cache.root, file))
		holder.exec('PRAGMA busy_timeout=250')
		holder.exec('BEGIN IMMEDIATE')
		try {
			const two = provider({ cacheDir: cache.root })
			// Readers are not blocked by a writer under WAL.
			const reply = ok(await two.findLiteral({ root: tree.root, text: 'locked-literal' }))
			expect(reply.value.total).toBe(1)
			await two.dispose()
		} finally {
			holder.exec('ROLLBACK')
			holder.close()
		}
		expect(readdirSync(cache.root).filter((f) => f.endsWith('.sqlite'))).toEqual([file])
	})

	it('removes a file that is not a database, and only then, and rebuilds', async () => {
		const tree = make({ 'a.js': 'function a(){ return "after-corruption" }\n' })
		const cache = make()
		const one = provider({ cacheDir: cache.root })
		ok(await one.index({ root: tree.root }))
		await one.dispose()
		const file = readdirSync(cache.root).find((f) => f.endsWith('.sqlite')) as string
		for (const f of readdirSync(cache.root)) rmSync(join(cache.root, f))
		writeFileSync(
			join(cache.root, file),
			'this is not a database, it is a text file that is long enough to look like one'.repeat(40),
		)

		const two = provider({ cacheDir: cache.root })
		expect(
			ok(await two.findLiteral({ root: tree.root, text: 'after-corruption' })).value.total,
		).toBe(1)
		await two.dispose()
	})

	it('names the cache file by schema and mode, so versions do not share one', async () => {
		const tree = make({ 'a.js': 'function a(){ return 1 }\n' })
		const cache = make()
		const withFts = provider({ cacheDir: cache.root })
		const scan = provider({ cacheDir: cache.root, substringIndex: 'off' })
		ok(await withFts.index({ root: tree.root }))
		ok(await scan.index({ root: tree.root }))
		const names = readdirSync(cache.root).filter((f) => f.endsWith('.sqlite'))
		expect(names.every((n) => /-v\d+-(fts|scan)\.sqlite$/.test(n))).toBe(true)
		expect(names).toContain(names.find((n) => n.endsWith('-scan.sqlite')))
		await withFts.dispose()
		await scan.dispose()
	})
})

describe('doubts settled', () => {
	it('binds a cursor to its root', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 8; i++) files[`f${i}.js`] = `function f${i}(){ return "same-literal" }\n`
		const a = make(files)
		const b = make(files)
		const p = provider()
		const page = ok(await p.findLiteral({ root: a.root, text: 'same-literal', limit: 3 })).value
		ok(await p.findLiteral({ root: b.root, text: 'same-literal', limit: 3 }))
		expect(
			failure(
				await p.findLiteral({
					root: b.root,
					text: 'same-literal',
					limit: 3,
					cursor: page.nextCursor as string,
				}),
			),
		).toContain('different query')
		await p.dispose()
	})

	it('flags files created after the index was built', async () => {
		const tree = make()
		tree.write('a.js', 'function a(){ return "old-literal" }\n', T0)
		utimesSync(tree.root, T0, T0)
		const p = provider()
		ok(await p.index({ root: tree.root }))
		const before = ok(await p.findLiteral({ root: tree.root, text: 'old-literal' }))
		expect(before.evidence.coverage.status).toBe('complete')

		tree.write('b.js', 'function b(){ return "new-literal" }\n')
		const after = ok(await p.findLiteral({ root: tree.root, text: 'old-literal' }))
		expect(after.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(after.evidence.coverage)).toMatch(/files added there may be missing/)
		ok(await p.index({ root: tree.root }))
		expect(ok(await p.findLiteral({ root: tree.root, text: 'new-literal' })).value.total).toBe(1)
		await p.dispose()
	})

	it('marks hits from a deleted file, and from a changed one', async () => {
		const tree = make()
		tree.write('gone.js', 'function gone(){ return "marked-literal" }\n', T0)
		tree.write('moved.js', 'function moved(){ return "marked-literal" }\n', T0)
		const p = provider()
		ok(await p.index({ root: tree.root }))
		rmSync(tree.path('gone.js'))
		tree.write('moved.js', '// shifted\nfunction moved(){ return "marked-literal" }\n', T0 + 99)
		const r = ok(await p.findLiteral({ root: tree.root, text: 'marked-literal' }))
		const byFile = Object.fromEntries(r.value.items.map((i) => [i.path.split('/').pop(), i.stale]))
		expect(byFile).toEqual({ 'gone.js': 'deleted', 'moved.js': 'changed' })
		expect(JSON.stringify(r.evidence.coverage)).toMatch(/deleted/)
		await p.dispose()
	})

	it('reports columns in the string the read tool shows, a byte-order mark included', async () => {
		const text = '﻿function f(){ return "bom-literal" }\n'
		const tree = make({ 'bom.js': text })
		const p = provider()
		const hit = ok(await p.findLiteral({ root: tree.root, text: 'bom-literal' })).value.items[0]
		const shown = readFileSync(tree.path('bom.js'), 'utf8')
		expect(shown).toBe(text)
		const want = locate(shown, '"bom-literal"')
		expect([hit?.line, hit?.column, hit?.start]).toEqual([want.line, want.column, want.offset])
		const fn = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('bom.js'),
				line: want.line,
				column: want.column,
			}),
		).value
		expect(fn.source?.text).toBe('function f(){ return "bom-literal" }')
		await p.dispose()
	})
})
