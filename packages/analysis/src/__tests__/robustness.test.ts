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
			kill: () => real.killChild(),
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
		// Recorded as partly covered, with the way to continue, and the generation
		// moved so a cursor issued before the abort stops matching.
		expect(store.meta('covered')).toContain('"k":"cancel"')
		expect(Number(store.meta('generation'))).toBeGreaterThan(0)
		const resumed = await store.run(() => refreshIndex(store, tree.root, tree.root, options, real))
		expect(resumed.indexed).toBe(6)
		expect(resumed.unchanged).toBe(kept)
		real.killChild()
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
		host.killChild()
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

describe('review: the child and the cache', () => {
	it('does not record a healthy file as crashed when the provider is disposed mid-index', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 200; i++) files[`f${i}.js`] = `function f${i}(){ return "lit-${i}" }\n`
		const tree = make(files)
		const cache = make()
		const p = provider({ cacheDir: cache.root })
		const running = p.index({ root: tree.root })
		await p.dispose()
		const result = await running
		// A cancellation, never an ok that hides it.
		expect(result.kind).toBe('failed')
		expect(failure(result)).toContain('cancelled')

		const again = provider({ cacheDir: cache.root })
		const out = ok(await again.index({ root: tree.root }))
		expect(out.value.skippedReasons['parser crashed']).toBeUndefined()
		expect(out.value.files.indexed).toBe(200)
		expect(out.evidence.coverage.status).toBe('complete')
		await again.dispose()
		// And a disposed provider answers, rather than spawning a child it would leak.
		expect((await p.index({ root: tree.root })).kind).toBe('failed')
	})

	it('rejects a parse of a disposed host and of a host killed on purpose, as cancellations', async () => {
		const host = new ParserHost()
		const big = `${'var a = 1;\n'.repeat(400_000)}`
		const inFlight = host.parse({ rel: 'big.js', abs: '/x/big.js', text: big })
		host.dispose()
		await expect(inFlight).rejects.toMatchObject({ name: 'AbortError' })
		await expect(host.parse({ rel: 'b.js', abs: '/x/b.js', text: 'var b' })).rejects.toMatchObject({
			name: 'AbortError',
		})
	})

	it('prefers the most specific covering entry, so a finished narrower scope ends the advice to index it', async () => {
		const files: Record<string, string> = {}
		for (let d = 0; d < 6; d++) files[`d${d}/m.js`] = `function m${d}(){ return "lit-${d}" }\n`
		files['h/h.js'] = 'function h(){ return "h-literal" }\n'
		const tree = make(files)
		const p = provider({ maxDirectories: 2 })
		const root = ok(await p.index({ root: tree.root }))
		expect(root.value.truncated).toBeDefined()
		ok(await p.index({ root: tree.root, scope: tree.path('h') }))
		const hit = ok(
			await p.findLiteral({ root: tree.root, text: 'h-literal', path: tree.path('h') }),
		)
		expect(hit.value.total).toBe(1)
		expect(hit.evidence.coverage.status).toBe('complete')
		await p.dispose()
	})

	it('matches member callers by bytes, not by folded case', async () => {
		const tree = make({ 'a.js': 'function f(){ obj.run(); obj.Run(); obj.RUN(); run() }\n' })
		const p = provider()
		const r = ok(
			await p.callersOf({ root: tree.root, name: 'run', scope: 'workspace', match: 'member' }),
		)
		expect(r.value.items.map((i) => i.callee).sort()).toEqual(['obj.run', 'run'])
		await p.dispose()
	})

	it('keeps the parent from exiting being held open by an idle child', async () => {
		const { execFile } = await import('node:child_process')
		const { promisify } = await import('node:util')
		const { fileURLToPath } = await import('node:url')
		const tree = make({ 'a.js': 'function a(){ return 1 }\n' })
		const script = fileURLToPath(new URL('../__fixtures__/noexit.mjs', import.meta.url))
		// If the idle child held the loop open this would never resolve, and the
		// runner's own test timeout would be what reports it.
		const { stdout } = await promisify(execFile)(process.execPath, [script, tree.root])
		expect(JSON.parse(stdout.trim())).toEqual({ kind: 'ok', indexed: 1 })
	}, 30_000)

	it('gives the child a minimal environment, with no secrets', async () => {
		const { fileURLToPath } = await import('node:url')
		const stand = fileURLToPath(new URL('../__fixtures__/env-parser.mjs', import.meta.url))
		const tree = make({ 'a.js': 'x\n' })
		process.env.NAMZU_TEST_SECRET_KEY = 'sk-should-not-reach-the-child'
		try {
			const p = provider({ parserModule: stand })
			const hit = ok(await p.findLiteral({ root: tree.root, text: 'PATH' })).value.items[0]
			const keys = JSON.parse(hit?.value ?? '[]') as string[]
			expect(keys).toContain('PATH')
			expect(keys).not.toContain('NAMZU_TEST_SECRET_KEY')
			expect(keys.every((k) => !/KEY|TOKEN|SECRET/i.test(k))).toBe(true)
			await p.dispose()
		} finally {
			Reflect.deleteProperty(process.env, 'NAMZU_TEST_SECRET_KEY')
		}
	})

	it('runs the child under the permission model: it cannot write, spawn or read the project', async () => {
		const { fileURLToPath } = await import('node:url')
		const { permissionArguments } = await import('../host.js')
		const script = fileURLToPath(new URL('../../dist/indexer-host.js', import.meta.url))
		const args = permissionArguments(script, undefined)
		expect(args).toContain('--permission')
		expect(args).toContain('--allow-addons')
		expect(args.some((a) => a.startsWith('--allow-fs-write'))).toBe(false)
		expect(args.some((a) => a.startsWith('--allow-child-process'))).toBe(false)
		// It still parses under it.
		const host = new ParserHost()
		const out = await host.parse({
			rel: 'a.js',
			abs: '/x/a.js',
			text: 'function a(){ return "ok" }',
		})
		expect(out.kind).toBe('rows')
		host.dispose()
	})

	it.runIf(process.platform === 'linux')(
		'starts the child outside the project, with no memory in its core dump',
		async () => {
			const { realpathSync, readlinkSync } = await import('node:fs')
			const { tmpdir } = await import('node:os')
			const host = new ParserHost()
			const out = await host.parse({ rel: 'a.js', abs: '/x/a.js', text: 'function a(){}' })
			expect(out.kind).toBe('rows')
			const pid = (host as unknown as { current?: { pid?: number } }).current?.pid
			expect(pid).toBeTypeOf('number')
			// No anonymous or file mapping is dumped: not the parser's 6 GiB buffer,
			// not the source it was given.
			expect(Number.parseInt(readFileSync(`/proc/${pid}/coredump_filter`, 'utf8'), 16)).toBe(0)
			expect(readlinkSync(`/proc/${pid}/cwd`)).toBe(realpathSync(tmpdir()))
			host.dispose()
		},
	)
})

describe('cache eviction', () => {
	const DAY = 24 * 60 * 60 * 1000

	function seed(dir: string, name: string, bytes: number, ageDays: number): void {
		const path = join(dir, name)
		writeFileSync(path, Buffer.alloc(bytes))
		const when = (Date.now() - ageDays * DAY) / 1000
		utimesSync(path, when, when)
	}

	it('removes databases unused for the age limit and keeps recent ones and the one in use', async () => {
		const cache = make()
		seed(cache.root, 'old-v1-fts.sqlite', 10, 90)
		seed(cache.root, 'recent-v1-fts.sqlite', 10, 2)
		const tree = make({ 'a.js': 'function a(){ return 1 }\n' })
		const p = provider({ cacheDir: cache.root, cacheMaxAgeDays: 30 })
		ok(await p.index({ root: tree.root }))
		// Eviction runs beside the open, not before the answer; give it its turn.
		await p.dispose()
		const { evictCaches } = await import('../evict.js')
		await evictCaches(cache.root, 'none', { maxAgeDays: 30, maxBytes: 1e12 })
		const left = readdirSync(cache.root).filter((f) => f.endsWith('.sqlite'))
		expect(left).not.toContain('old-v1-fts.sqlite')
		expect(left).toContain('recent-v1-fts.sqlite')
		expect(left.length).toBe(2)
	})

	it('trims least recently used databases until the directory fits, sparing the one named', async () => {
		const { evictCaches } = await import('../evict.js')
		const cache = make()
		seed(cache.root, 'a-v1-fts.sqlite', 1000, 10)
		seed(cache.root, 'b-v1-fts.sqlite', 1000, 5)
		seed(cache.root, 'c-v1-fts.sqlite', 1000, 3)
		const removed = await evictCaches(cache.root, 'c-v1-fts.sqlite', {
			maxAgeDays: 365,
			maxBytes: 1500,
		})
		expect(removed).toEqual(['a-v1-fts.sqlite', 'b-v1-fts.sqlite'])
		expect(readdirSync(cache.root)).toEqual(['c-v1-fts.sqlite'])
	})

	it('does not touch a database used in the last hour, whatever the size limit says', async () => {
		const { evictCaches } = await import('../evict.js')
		const cache = make()
		seed(cache.root, 'busy-v1-fts.sqlite', 1000, 0)
		expect(await evictCaches(cache.root, 'x', { maxAgeDays: 0, maxBytes: 1 })).toEqual([])
	})
})

describe('the descriptor check', () => {
	it('says an open file inside the root is inside, and one outside is not', async () => {
		const { descriptorInside } = await import('../fsafe.js')
		const { openSync, closeSync, fstatSync } = await import('node:fs')
		const inside = make({ 'a.js': 'x' })
		const outside = make({ 'b.js': 'y' })
		const fdIn = openSync(inside.path('a.js'), 'r')
		const fdOut = openSync(outside.path('b.js'), 'r')
		try {
			expect(await descriptorInside(inside.root, fdIn, inside.path('a.js'), fstatSync(fdIn))).toBe(
				true,
			)
			// The path the caller believes in is inside; the descriptor is not.
			expect(
				await descriptorInside(inside.root, fdOut, inside.path('a.js'), fstatSync(fdOut)),
			).toBe(false)
		} finally {
			closeSync(fdIn)
			closeSync(fdOut)
		}
	})

	it('refuses a FIFO swapped in for a file, without blocking on it', async () => {
		const { execFileSync } = await import('node:child_process')
		const { readRegular } = await import('../fsafe.js')
		const tree = make()
		execFileSync('mkfifo', [tree.path('pipe.js')])
		const out = await readRegular(tree.root, tree.path('pipe.js'))
		expect(out).toEqual({ ok: false, why: 'not-file' })
	})
})
