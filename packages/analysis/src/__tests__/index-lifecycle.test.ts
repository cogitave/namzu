import { existsSync, readdirSync, symlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Tree, drain, failure, ok, provider } from './helpers.js'

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

describe('incremental indexing', () => {
	it('re-parses only the file that changed', async () => {
		const tree = make()
		tree.write('a.js', 'function a(){return "A1"}', T0)
		tree.write('b.js', 'function b(){return "B1"}', T0)
		tree.write('c.js', 'function c(){return "C1"}', T0)
		const p = provider()
		const root = tree.root

		const first = ok(await p.index({ root })).value
		expect(first.files).toMatchObject({ indexed: 3, parsed: 3, unchanged: 0, removed: 0 })

		const again = ok(await p.index({ root })).value
		expect(again.files).toMatchObject({ indexed: 3, parsed: 0, unchanged: 3 })

		tree.write('b.js', 'function b(){return "B2-changed"}', T0 + 10)
		const edited = ok(await p.index({ root })).value
		expect(edited.files).toMatchObject({ indexed: 3, parsed: 1, unchanged: 2 })
		expect(ok(await p.findLiteral({ root, text: 'B2-changed' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root, text: 'B1' })).value.total).toBe(0)
		await p.dispose()
	})

	it('does not re-parse a file whose bytes are identical under a new mtime', async () => {
		const tree = make()
		tree.write('a.js', 'function a(){return "A1"}', T0)
		const p = provider()
		ok(await p.index({ root: tree.root }))
		utimesSync(tree.path('a.js'), T0 + 500, T0 + 500)
		const touched = ok(await p.index({ root: tree.root })).value
		expect(touched.files).toMatchObject({ parsed: 0, unchanged: 1 })
		// ...and the new mtime was recorded, so the cheap check passes next time.
		const next = ok(await p.index({ root: tree.root })).value
		expect(next.files).toMatchObject({ parsed: 0, unchanged: 1 })
		await p.dispose()
	})

	it('drops deleted files, picks up new ones, and re-reads everything under force', async () => {
		const tree = make()
		tree.write('a.js', 'function a(){return "only-in-a"}', T0)
		tree.write('b.js', 'function b(){return 1}', T0)
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))

		const { rmSync } = await import('node:fs')
		rmSync(tree.path('a.js'))
		tree.write('d.js', 'function d(){return "new-in-d"}', T0)
		const out = ok(await p.index({ root })).value
		expect(out.files).toMatchObject({ indexed: 2, parsed: 1, removed: 1, unchanged: 1 })
		expect(ok(await p.findLiteral({ root, text: 'only-in-a' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root, text: 'new-in-d' })).value.total).toBe(1)

		const forced = ok(await p.index({ root, force: true })).value
		expect(forced.files).toMatchObject({ parsed: 2, unchanged: 0 })
		await p.dispose()
	})

	it('survives a restart: a second provider on the same cache directory parses nothing', async () => {
		const tree = make({
			'a.js': 'function a(){return "kept"}',
			'b.ts': 'export const b = () => "kept-too"',
		})
		const cache = make()
		const one = provider({ cacheDir: cache.root })
		const built = ok(await one.index({ root: tree.root })).value
		expect(built).toMatchObject({ persisted: true, files: { parsed: 2 } })
		await one.dispose()

		const two = provider({ cacheDir: cache.root })
		const reused = ok(await two.index({ root: tree.root })).value
		expect(reused.files).toMatchObject({ parsed: 0, unchanged: 2 })
		expect(ok(await two.findLiteral({ root: tree.root, text: 'kept-too' })).value.total).toBe(1)
		await two.dispose()
	})

	it('keys the cache by the root real path, so a symlinked spelling shares it', async () => {
		const tree = make({ 'a.js': 'function a(){return 1}' })
		const holder = make()
		const link = join(holder.root, 'alias')
		symlinkSync(tree.root, link)
		const cache = make()
		const p = provider({ cacheDir: cache.root })
		ok(await p.index({ root: tree.root }))
		const viaLink = ok(await p.index({ root: link })).value
		expect(viaLink.files.parsed).toBe(0)
		expect(readdirSync(cache.root).filter((f) => f.endsWith('.sqlite'))).toHaveLength(1)
		await p.dispose()
	})

	it('builds on first use, and says so', async () => {
		const tree = make({ 'a.js': 'function a(){return "lazy-built"}' })
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'lazy-built' }))
		expect(r.value.total).toBe(1)
		expect(r.evidence.observed.join(' ')).toContain('was built for this call')
		const second = ok(await p.findLiteral({ root: tree.root, text: 'lazy-built' }))
		expect(second.evidence.observed.join(' ')).not.toContain('was built for this call')
		await p.dispose()
	})

	it('falls back to memory, and says so, when the cache directory cannot be written', async () => {
		const tree = make({ 'a.js': 'function a(){return 1}' })
		const blocker = make({ file: 'not a directory' })
		const p = provider({ cacheDir: join(blocker.root, 'file', 'nested') })
		const out = ok(await p.index({ root: tree.root })).value
		expect(out.persisted).toBe(false)
		expect(out.files.indexed).toBe(1)
		await p.dispose()
	})
})

describe('what is and is not indexed', () => {
	it('skips a binary .js file without failing, counts it, and reports coverage as partial', async () => {
		const bytes = new Uint8Array(4096)
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) & 0xff
		bytes[10] = 0
		const tree = make({
			'good.js': 'function good(){return "fine"}',
			'blob.js': bytes,
			'latin1.js': new Uint8Array([0x66, 0x6f, 0x6f, 0xe9, 0xff, 0xfe, 0x3b]),
		})
		const p = provider()
		const out = ok(await p.index({ root: tree.root }))
		expect(out.value.files).toMatchObject({ indexed: 1, skipped: 2 })
		expect(out.value.skippedReasons['binary or not UTF-8']).toBe(2)
		expect(out.evidence.coverage.status).toBe('partial')
		const found = ok(await p.findLiteral({ root: tree.root, text: 'fine' }))
		expect(found.value.total).toBe(1)
		expect(found.evidence.coverage.status).toBe('partial')
		await p.dispose()
	})

	it('ignores node_modules, declaration files and symlinks, and indexes the rest', async () => {
		const tree = make({
			'src/a.ts': 'export const a = () => "src-a"',
			'node_modules/dep/index.js': 'module.exports = function dep(){return "from-dep"}',
			'types/x.d.ts': 'export declare const x: "decl-literal"',
			'z.mjs': 'export default () => "esm-z"',
			'y.cjs': 'module.exports = () => "cjs-y"',
			'ui/App.tsx': 'export const App = () => <div title="jsx-title" />',
			'notes.txt': 'function nope(){return "text-file"}',
		})
		symlinkSync(tree.path('src/a.ts'), tree.path('linked.ts'))
		const p = provider()
		const root = tree.root
		const out = ok(await p.index({ root })).value
		expect(out.files.indexed).toBe(4)
		for (const [text, total] of [
			['src-a', 1],
			['from-dep', 0],
			['decl-literal', 0],
			['esm-z', 1],
			['cjs-y', 1],
			['jsx-title', 1],
			['text-file', 0],
		] as const) {
			expect(ok(await p.findLiteral({ root, text })).value.total, text).toBe(total)
		}
		await p.dispose()
	})

	it('records a file with syntax errors, keeps the lines around the error, and says rows may be missing', async () => {
		const tree = make({
			'broken.js': 'function ok1(){return "before-the-error"}\nfunction ( {\nconst x = ;\n',
			'fine.js': 'function f(){return "after-fine"}',
		})
		const p = provider()
		const root = tree.root
		const out = ok(await p.index({ root }))
		expect(out.value.files).toMatchObject({ indexed: 2, withParseErrors: 1 })
		expect(out.evidence.coverage.status).toBe('partial')
		// The parser panics on this input and returns an empty program. The
		// broken lines are set aside and the rest is read: the function before the
		// error is found, with the gap reported.
		const found = ok(await p.findLiteral({ root, text: 'before-the-error' }))
		expect(found.value.total).toBe(1)
		expect(found.value.items[0]?.function?.name).toBe('ok1')
		expect(found.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(found.evidence.coverage)).toContain('syntax errors')
		const kept = ok(await p.findLiteral({ root, text: 'after-fine' }))
		expect(kept.value.total).toBe(1)
		await p.dispose()
	})

	it('stops at the file cap and says so', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 10; i++) files[`f${i}.js`] = `function f${i}(){return ${i}}`
		const tree = make(files)
		const p = provider({ maxFiles: 4 })
		const out = ok(await p.index({ root: tree.root }))
		expect(out.value.files.indexed).toBe(4)
		expect(out.value.truncated).toContain('4-file limit')
		expect(out.evidence.coverage.status).toBe('partial')
		await p.dispose()
	})

	it('skips an over-size file and counts it', async () => {
		const tree = make({
			'big.js': `const s = "${'x'.repeat(2000)}"`,
			'small.js': 'function s(){return 1}',
		})
		const p = provider({ maxFileBytes: 1000 })
		const out = ok(await p.index({ root: tree.root })).value
		expect(out.files.indexed).toBe(1)
		expect(Object.keys(out.skippedReasons).join(' ')).toContain('size limit')
		await p.dispose()
	})

	it('refuses a root that is not a directory, without throwing', async () => {
		const tree = make({ 'a.js': '1' })
		const p = provider()
		expect(failure(await p.index({ root: tree.path('a.js') }))).toContain('not a directory')
		expect(failure(await p.index({ root: tree.path('missing') }))).toContain('does not exist')
		await p.dispose()
	})

	it('reports a file that is not in the index with the reason', async () => {
		const tree = make({ 'a.js': 'function a(){return 1}', 'readme.md': '# hi' })
		const p = provider()
		const msg = failure(
			await p.enclosingFunction({ root: tree.root, path: tree.path('readme.md'), line: 1 }),
		)
		expect(msg).toContain('not in the index')
		expect(existsSync(tree.path('readme.md'))).toBe(true)
		await p.dispose()
	})
})

describe('substring index modes', () => {
	const files = {
		'a.js': 'function a(){return "Alpha needle"}\nfunction b(){return "beta NEEDLE"}',
		'b.js': 'const s = "ne"; const t = "needle again"',
	}

	it('answers identically with and without the FTS prefilter, for case and short needles', async () => {
		const tree = make(files)
		const auto = provider()
		const off = provider({ substringIndex: 'off' })
		for (const query of [
			{ text: 'needle' },
			{ text: 'needle', caseSensitive: false },
			{ text: 'ne' },
			{ text: 'Alpha needle' },
			{ text: 'no such thing' },
		]) {
			const a = await drain((cursor) =>
				auto.findLiteral({ root: tree.root, ...query, ...(cursor ? { cursor } : {}) }),
			)
			const b = await drain((cursor) =>
				off.findLiteral({ root: tree.root, ...query, ...(cursor ? { cursor } : {}) }),
			)
			expect(
				b.items.map((i) => [i.path, i.start]),
				JSON.stringify(query),
			).toEqual(a.items.map((i) => [i.path, i.start]))
		}
		expect(
			ok(await off.findLiteral({ root: tree.root, text: 'needle', caseSensitive: false })).value
				.total,
		).toBe(3)
		expect(ok(await off.findLiteral({ root: tree.root, text: 'needle' })).value.total).toBe(2)
		await auto.dispose()
		await off.dispose()
	})

	it('rebuilds a cache made with the substring index when it is turned off, and stays correct', async () => {
		const tree = make(files)
		const cache = make()
		const withFts = provider({ cacheDir: cache.root })
		ok(await withFts.index({ root: tree.root }))
		await withFts.dispose()

		const without = provider({ cacheDir: cache.root, substringIndex: 'off' })
		const out = ok(await without.index({ root: tree.root }))
		// If this Node has FTS5 the cache was made with it and must be rebuilt.
		expect(out.value.files.indexed).toBe(2)
		expect(
			ok(await without.findLiteral({ root: tree.root, text: 'needle again' })).value.total,
		).toBe(1)
		await without.dispose()
	})

	it('keeps the index consistent through edits when the substring index is on', async () => {
		const tree = make({ 'a.js': 'function a(){return "first-version"}' })
		tree.write('a.js', 'function a(){return "first-version"}', T0)
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('a.js', 'function a(){return "second-version"}', T0 + 100)
		ok(await p.index({ root }))
		expect(ok(await p.findLiteral({ root, text: 'first-version' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root, text: 'second-version' })).value.total).toBe(1)
		await p.dispose()
	})
})
