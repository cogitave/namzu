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

function manyHits(n: number): Record<string, string> {
	const files: Record<string, string> = {}
	for (let i = 0; i < n; i++) {
		files[`m${String(i).padStart(2, '0')}.js`] = `function f${i}(){return "shared-literal-${i}"}`
	}
	return files
}

describe('paging', () => {
	it('pages find_literal with a stable total, no repeats and a closing page', async () => {
		const tree = make(manyHits(25))
		const p = provider()
		const root = tree.root
		const first = ok(await p.findLiteral({ root, text: 'shared-literal', limit: 10 }))
		expect(first.value.total).toBe(25)
		expect(first.value.items).toHaveLength(10)
		expect(first.value.nextCursor).toBeDefined()

		const all = await drain((cursor) =>
			p.findLiteral({ root, text: 'shared-literal', limit: 10, ...(cursor ? { cursor } : {}) }),
		)
		expect(all.pages).toBe(3)
		expect(all.total).toBe(25)
		expect(all.items).toHaveLength(25)
		expect(new Set(all.items.map((i) => `${i.path}:${i.start}`)).size).toBe(25)
		const last = ok(
			await p.findLiteral({
				root,
				text: 'shared-literal',
				limit: 10,
				cursor: first.value.nextCursor as string,
			}),
		)
		expect(last.value.items).toHaveLength(10)
		await p.dispose()
	})

	it('has no cursor on a result that fits in one page, and clamps a silly limit', async () => {
		const tree = make(manyHits(3))
		const p = provider()
		const page = ok(
			await p.findLiteral({ root: tree.root, text: 'shared-literal', limit: 100_000 }),
		).value
		expect(page.items).toHaveLength(3)
		expect(page.nextCursor).toBeUndefined()
		const clamped = ok(
			await p.findLiteral({ root: tree.root, text: 'shared-literal', limit: 0 }),
		).value
		expect(clamped.items.length).toBe(1)
		await p.dispose()
	})

	it('rejects a cursor from another query, from another index state, and from nowhere', async () => {
		const tree = make(manyHits(12))
		const p = provider()
		const root = tree.root
		const page = ok(await p.findLiteral({ root, text: 'shared-literal', limit: 5 })).value
		const cursor = page.nextCursor as string

		expect(
			failure(await p.findLiteral({ root, text: 'something-else', limit: 5, cursor })),
		).toContain('different query')
		expect(
			failure(await p.findLiteral({ root, text: 'shared-literal', cursor: 'garbage' })),
		).toContain('not one this index issued')

		tree.write('m00.js', 'function f0(){return "shared-literal-rewritten"}', T0 + 50)
		ok(await p.index({ root }))
		expect(
			failure(await p.findLiteral({ root, text: 'shared-literal', limit: 5, cursor })),
		).toContain('index changed')
		await p.dispose()
	})

	it('pages callers_of and imports too', async () => {
		const calls = Array.from({ length: 12 }, (_, i) => `function c${i}(){ target(${i}) }`).join(
			'\n',
		)
		const imports = Array.from(
			{ length: 12 },
			(_, i) => `import { n${i} } from './dep${i}.js'`,
		).join('\n')
		const tree = make({ 'calls.js': calls, 'imports.js': imports })
		const p = provider()
		const root = tree.root
		const callers = await drain((cursor) =>
			p.callersOf({
				root,
				name: 'target',
				path: tree.path('calls.js'),
				limit: 5,
				...(cursor ? { cursor } : {}),
			}),
		)
		expect(callers.items).toHaveLength(12)
		expect(callers.pages).toBe(3)
		const edges = await drain((cursor) =>
			p.imports({ root, path: tree.path('imports.js'), limit: 5, ...(cursor ? { cursor } : {}) }),
		)
		expect(edges.items).toHaveLength(12)
		await p.dispose()
	})
})

describe('callers_of', () => {
	const files = {
		'a.js': [
			'function run(){ helper(1) }',
			'function other(){ helper(2); helper(3); obj.helper(4); new Helper(5) }',
		].join('\n'),
		'b.js': 'function third(){ helper(9); this.helper(1); a_b(1); axb(2) }',
		'pct.js': 'function p(){ 100%(1) }',
	}

	it('is per file by default and says the match is by text', async () => {
		const tree = make(files)
		const p = provider()
		const root = tree.root
		const inA = ok(await p.callersOf({ root, name: 'helper', path: tree.path('a.js') }))
		expect(inA.value.total).toBe(3)
		expect(inA.value.items.map((i) => i.caller?.name)).toEqual(['run', 'other', 'other'])
		expect(inA.value.items.every((i) => i.path === tree.path('a.js'))).toBe(true)
		expect(inA.evidence.inferred.join(' ')).toContain('callee TEXT')
		expect(inA.evidence.observed.join(' ')).toContain('in 1 file(s)')
		await p.dispose()
	})

	it('widens only when asked, warns that names are shared, and can match by member', async () => {
		const tree = make(files)
		const p = provider()
		const root = tree.root
		const wide = ok(await p.callersOf({ root, name: 'helper', scope: 'workspace' }))
		expect(wide.value.total).toBe(4)
		expect(wide.evidence.inferred.join(' ')).toContain(
			'may be different functions that share a name',
		)
		const member = ok(
			await p.callersOf({ root, name: 'helper', scope: 'workspace', match: 'member' }),
		)
		// helper(1) helper(2) helper(3) helper(9) + obj.helper + this.helper
		expect(member.value.total).toBe(6)
		const narrowed = ok(
			await p.callersOf({ root, name: 'helper', scope: 'workspace', path: tree.root }),
		)
		expect(narrowed.value.total).toBe(4)
		await p.dispose()
	})

	it('reports constructor calls as new, and an unknown name as an empty page, not a failure', async () => {
		const tree = make(files)
		const p = provider()
		const root = tree.root
		const ctor = ok(await p.callersOf({ root, name: 'Helper', path: tree.path('a.js') })).value
		expect(ctor.items[0]).toMatchObject({ kind: 'new', argumentCount: 1 })
		const none = ok(await p.callersOf({ root, name: 'nobody', path: tree.path('a.js') }))
		expect(none.value).toEqual({ items: [], total: 0 })
		expect(none.evidence.coverage.status).toBe('complete')
		await p.dispose()
	})

	it('does not let LIKE wildcards in a member name match other names', async () => {
		const tree = make(files)
		const p = provider()
		const r = ok(
			await p.callersOf({ root: tree.root, name: 'a_b', scope: 'workspace', match: 'member' }),
		)
		expect(r.value.total).toBe(1)
		await p.dispose()
	})

	it('needs a path for the file scope', async () => {
		const tree = make(files)
		const p = provider()
		expect(failure(await p.callersOf({ root: tree.root, name: 'helper' }))).toContain(
			'needs `path`',
		)
		await p.dispose()
	})
})

describe('imports and exports', () => {
	const source = [
		"import def, { a, b as c } from './m.js'",
		"import * as ns from './ns.js'",
		"import type { T } from './types.js'",
		"import './side-effect.js'",
		"const req = require('./cjs.js')",
		"const lazy = () => import('./lazy.js')",
		"export * from './all.js'",
		"export * as grouped from './grouped.js'",
		"export { x as y, z } from './re.js'",
		'export const k1 = 1, k2 = 2',
		'export function fn() {}',
		'export default class {}',
		'const loose = 3',
		'export { loose }',
		'',
	].join('\n')

	it('lists every edge with its kind, names and position', async () => {
		const tree = make({ 'm.ts': source })
		const p = provider()
		const r = ok(await p.imports({ root: tree.root, path: tree.path('m.ts'), limit: 100 })).value
		const imports = r.items.filter((e) => e.direction === 'import')
		const exports = r.items.filter((e) => e.direction === 'export')
		expect(imports.map((e) => [e.kind, e.direction === 'import' ? e.source : ''])).toEqual([
			['static', './m.js'],
			['static', './ns.js'],
			['type', './types.js'],
			['static', './side-effect.js'],
			['require', './cjs.js'],
			['dynamic', './lazy.js'],
		])
		expect(imports[0]).toMatchObject({
			names: ['default as def', 'a', 'b as c'],
			line: 1,
			column: 1,
		})
		expect(imports[1]).toMatchObject({ names: ['* as ns'] })
		expect(imports[4]).toMatchObject({ line: 5, column: 13 })
		expect(
			exports.map((e) => [
				e.kind,
				e.direction === 'export' ? e.name : '',
				e.direction === 'export' ? (e.source ?? '') : '',
			]),
		).toEqual([
			['star', '*', './all.js'],
			['star', 'grouped', './grouped.js'],
			['reexport', 'y', './re.js'],
			['reexport', 'z', './re.js'],
			['named', 'k1', ''],
			['named', 'k2', ''],
			['named', 'fn', ''],
			['default', 'default', ''],
			['named', 'loose', ''],
		])
		await p.dispose()
	})
})

describe('function_source', () => {
	const source = `function big(){ return "${'y'.repeat(5000)}" }\nfunction dup(){return 1}\nconst o = { dup(){ return 2 } }\n`

	it('cuts a long function at the cap and says so, never silently', async () => {
		const tree = make({ 'a.js': source })
		const p = provider()
		const r = ok(
			await p.functionSource({
				root: tree.root,
				path: tree.path('a.js'),
				name: 'big',
				maxChars: 300,
			}),
		).value.items[0]
		expect(r?.source.truncated).toBe(true)
		expect(r?.source.text).toHaveLength(300)
		expect(r?.source.chars).toBeGreaterThan(5000)
		const whole = ok(
			await p.functionSource({ root: tree.root, path: tree.path('a.js'), name: 'big' }),
		).value.items[0]
		expect(whole?.source.truncated).toBe(false)
		expect(whole?.source.text.endsWith('" }')).toBe(true)
		await p.dispose()
	})

	it('returns every function that shares a name, by id and by name', async () => {
		const tree = make({ 'a.js': source })
		const p = provider()
		const both = ok(
			await p.functionSource({ root: tree.root, path: tree.path('a.js'), name: 'dup' }),
		).value
		expect(both.total).toBe(2)
		expect(both.items.map((i) => i.function.kind)).toEqual(['declaration', 'method'])
		const id = both.items[1]?.function.id as number
		const byId = ok(await p.functionSource({ root: tree.root, id })).value
		expect(byId.items[0]?.source.text).toBe('dup(){ return 2 }')
		expect(failure(await p.functionSource({ root: tree.root, id: 999_999 }))).toContain(
			'no function with id',
		)
		expect(failure(await p.functionSource({ root: tree.root }))).toContain('needs `id`')
		await p.dispose()
	})

	it('cuts on a code-point boundary', async () => {
		const tree = make({ 'a.js': `function e(){ return "${'😀'.repeat(400)}" }` })
		const p = provider()
		const r = ok(
			await p.functionSource({
				root: tree.root,
				path: tree.path('a.js'),
				name: 'e',
				maxChars: 201,
			}),
		).value.items[0]
		const text = r?.source.text ?? ''
		expect(text.length).toBeLessThanOrEqual(201)
		const last = text.charCodeAt(text.length - 1)
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
		await p.dispose()
	})
})

describe('evidence when the disk moved under the index', () => {
	it('flags hits from a file that changed, and the slice is never cut from different text', async () => {
		const tree = make()
		tree.write('a.js', 'function a(){return "stable-literal"}', T0)
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))

		// A leading comment shifts every offset; the index still has the old ones.
		tree.write('a.js', '// moved\nfunction a(){return "stable-literal"}', T0 + 100)
		const hits = ok(await p.findLiteral({ root, text: 'stable-literal' }))
		expect(hits.value.total).toBe(1)
		expect(hits.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(hits.evidence.coverage)).toContain('changed on disk')

		// A position query re-reads the file first, so the answer is right.
		const fn = ok(await p.enclosingFunction({ root, path: tree.path('a.js'), line: 2, column: 25 }))
		expect(fn.value.function?.name).toBe('a')
		expect(fn.value.source?.text).toBe('function a(){return "stable-literal"}')
		expect(fn.evidence.observed.join(' ')).toContain(
			'had changed since it was indexed and was re-read',
		)

		const again = ok(await p.findLiteral({ root, text: 'stable-literal' }))
		expect(again.evidence.coverage.status).toBe('complete')
		expect(again.value.items[0]?.line).toBe(2)
		await p.dispose()
	})

	it('catches a rewrite that keeps size and mtime, because slices are verified by content hash', async () => {
		const tree = make()
		tree.write('a.js', 'function a(){return "aaaa"}', T0)
		const p = provider()
		const root = tree.root
		const id = ok(await p.functionSource({ root, path: tree.path('a.js'), name: 'a' })).value
			.items[0]?.function.id as number
		tree.write('a.js', 'function a(){return "bbbb"}', T0)
		const reply = await p.functionSource({ root, id })
		expect(failure(reply)).toContain('changed since it was indexed')
		// The index was refreshed on the way, so a fresh lookup now works.
		const fresh = ok(await p.functionSource({ root, path: tree.path('a.js'), name: 'a' })).value
			.items[0]
		expect(fresh?.source.text).toBe('function a(){return "bbbb"}')
		await p.dispose()
	})

	it('reports a file deleted after indexing instead of answering from its rows', async () => {
		const tree = make({ 'a.js': 'function a(){return 1}', 'b.js': 'function b(){return 2}' })
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		const { rmSync } = await import('node:fs')
		rmSync(tree.path('a.js'))
		expect(
			failure(await p.enclosingFunction({ root, path: tree.path('a.js'), line: 1, column: 14 })),
		).toContain('no longer exists')
		expect(ok(await p.index({ root })).value.files.indexed).toBe(1)
		await p.dispose()
	})
})

describe('roots', () => {
	it('keeps two roots separate and refuses a path outside the root', async () => {
		const one = make({ 'a.js': 'function a(){return "only-one"}' })
		const two = make({ 'a.js': 'function a(){return "only-two"}' })
		const p = provider()
		expect(ok(await p.findLiteral({ root: one.root, text: 'only-two' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root: two.root, text: 'only-two' })).value.total).toBe(1)
		expect(
			failure(
				await p.enclosingFunction({ root: one.root, path: two.path('a.js'), line: 1, column: 1 }),
			),
		).toContain('not a file under the indexed root')
		expect(failure(await p.findLiteral({ root: one.root, text: 'x', path: two.root }))).toContain(
			'outside the indexed root',
		)
		await p.dispose()
	})

	it('scopes find_literal to a directory or a single file', async () => {
		const tree = make({
			'src/a.js': 'function a(){return "scoped-hit"}',
			'src/deep/b.js': 'function b(){return "scoped-hit"}',
			'srcother/c.js': 'function c(){return "scoped-hit"}',
		})
		const p = provider()
		const root = tree.root
		expect(ok(await p.findLiteral({ root, text: 'scoped-hit' })).value.total).toBe(3)
		// `src` must not also match the sibling `srcother`.
		expect(
			ok(await p.findLiteral({ root, text: 'scoped-hit', path: tree.path('src') })).value.total,
		).toBe(2)
		expect(
			ok(await p.findLiteral({ root, text: 'scoped-hit', path: tree.path('src/a.js') })).value
				.total,
		).toBe(1)
		await p.dispose()
	})
})
