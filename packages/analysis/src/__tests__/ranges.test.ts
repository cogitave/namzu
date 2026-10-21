import { afterEach, describe, expect, it } from 'vitest'

import { Tree, failure, locate, ok, provider } from './helpers.js'

/**
 * Where things are, to the character.
 *
 * Every expected position here is computed from the source text by counting,
 * not copied from the index's own answer, so a bug that shifts every offset by
 * the same amount cannot pass.
 */

const trees: Tree[] = []
const make = (files: Record<string, string | Uint8Array>) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

describe('UTF-16 positions', () => {
	// BMP non-ASCII (3 bytes in UTF-8, 1 unit in UTF-16) and an astral
	// character (4 bytes, 2 units) BEFORE the literal on the same line.
	const source = [
		'// 日本語のコメント 😀',
		'const label = "日本語😀"; function pick() { return "needle-é-😀-x" }',
		'',
	].join('\n')

	it('cites the literal at the character the editor shows, counting an astral character as two', async () => {
		const tree = make({ 'a.js': source })
		const p = provider()
		const root = tree.root
		const hit = ok(await p.findLiteral({ root, text: 'needle-é' })).value.items[0]
		const want = locate(source, '"needle-é')
		expect(hit?.start).toBe(want.offset)
		expect(hit?.line).toBe(want.line)
		expect(hit?.column).toBe(want.column)
		// The literal is the quoted token: its range is exactly that substring.
		expect(source.slice(hit?.start, hit?.end)).toBe('"needle-é-😀-x"')
		await p.dispose()
	})

	it('gives the function the exact UTF-16 slice, and a position after an astral character resolves', async () => {
		const tree = make({ 'a.js': source })
		const p = provider()
		const want = locate(source, 'function pick')
		const probe = locate(source, 'x"')
		const out = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('a.js'),
				line: probe.line,
				column: probe.column,
			}),
		).value
		expect(out.function?.name).toBe('pick')
		expect(out.function?.start).toBe(want.offset)
		expect(out.function?.line).toBe(want.line)
		expect(out.function?.column).toBe(want.column)
		expect(out.source?.text).toBe('function pick() { return "needle-é-😀-x" }')
		expect(out.source?.truncated).toBe(false)
		await p.dispose()
	})

	it('treats a column past the end of the line as an error, not as the last character', async () => {
		const tree = make({ 'a.js': source })
		const p = provider()
		const reply = await p.enclosingFunction({
			root: tree.root,
			path: tree.path('a.js'),
			line: 2,
			column: 5000,
		})
		expect(failure(reply)).toContain('outside line 2')
		const nowhere = await p.enclosingFunction({
			root: tree.root,
			path: tree.path('a.js'),
			line: 99,
		})
		expect(failure(nowhere)).toContain('outside the file')
		await p.dispose()
	})

	it('says a top-level position is in no function, which is an answer', async () => {
		const tree = make({ 'a.js': source })
		const p = provider()
		const r = ok(
			await p.enclosingFunction({ root: tree.root, path: tree.path('a.js'), line: 2, column: 3 }),
		)
		expect(r.value.function).toBeNull()
		expect(r.evidence.observed.join(' ')).toContain('top level')
		await p.dispose()
	})

	it('ends a function at its last character, half-open', async () => {
		const tree = make({ 'a.js': 'function f(){return 1}\nconst after = 2\n' })
		const p = provider()
		const end = 'function f(){return 1}'.length
		const inside = ok(
			await p.enclosingFunction({ root: tree.root, path: tree.path('a.js'), line: 1, column: end }),
		)
		expect(inside.value.function?.name).toBe('f')
		const at = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('a.js'),
				line: 1,
				column: end + 1,
			}),
		)
		expect(at.value.function).toBeNull()
		await p.dispose()
	})
})

describe('a single-line minified file', () => {
	// 300 functions on one line, with a distinctive literal in one of them.
	const parts: string[] = []
	for (let i = 0; i < 300; i++) {
		parts.push(`function f${i}(a){return a+${i}${i === 217 ? ',"needle-217"' : ''}}`)
	}
	const source = `${parts.join('')};f0(1)`

	it('finds the right function by column alone', async () => {
		const tree = make({ 'min.js': source })
		const p = provider()
		const hit = ok(await p.findLiteral({ root: tree.root, text: 'needle-217' })).value.items[0]
		expect(hit?.line).toBe(1)
		expect(hit?.column).toBe(locate(source, '"needle-217"').column)
		expect(hit?.column).toBeGreaterThan(5000)
		expect(hit?.function?.name).toBe('f217')
		const fn = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('min.js'),
				line: 1,
				column: hit?.column ?? 1,
			}),
		).value
		expect(fn.function?.name).toBe('f217')
		expect(fn.source?.text).toBe('function f217(a){return a+217,"needle-217"}')
		await p.dispose()
	})
})

describe('function shapes', () => {
	const source = [
		'class Box extends Base {',
		'  constructor(x) { super(x); this.k = "ctor-lit" }',
		'  static async load(id) { return await get("method-lit") }',
		'  get size() { return "getter-lit" }',
		'  set size(v) { this.v = "setter-lit" }',
		'  handler = (e) => { return "arrow-prop-lit" }',
		'  #secret() { return "private-lit" }',
		'}',
		'const api = { run() { return "obj-method-lit" }, get z() { return 1 }, fn: function () { return "fn-expr-lit" } }',
		'const outer = () => { const inner = () => "nested-lit"; return inner }',
		'',
	].join('\n')

	async function lit(text: string) {
		const tree = make({ 'shapes.js': source })
		const p = provider()
		const hit = ok(await p.findLiteral({ root: tree.root, text })).value.items[0]
		const fn = hit?.function
		const full = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('shapes.js'),
				line: hit?.line ?? 1,
				column: hit?.column ?? 1,
			}),
		).value
		await p.dispose()
		return { fn, full }
	}

	it('names and kinds each shape, and takes a method range from the member, not the inner function', async () => {
		const ctor = await lit('ctor-lit')
		expect([ctor.fn?.kind, ctor.fn?.name]).toEqual(['constructor', 'constructor'])
		const method = await lit('method-lit')
		expect([method.fn?.kind, method.fn?.name]).toEqual(['method', 'load'])
		// `static async load(id)` — the slice must include the modifiers and the
		// name, which the inner FunctionExpression's own range does not.
		expect(method.full.source?.text.startsWith('static async load(id)')).toBe(true)
		const getter = await lit('getter-lit')
		expect([getter.fn?.kind, getter.fn?.name]).toEqual(['getter', 'size'])
		expect(getter.full.source?.text.startsWith('get size()')).toBe(true)
		const setter = await lit('setter-lit')
		expect([setter.fn?.kind, setter.fn?.name]).toEqual(['setter', 'size'])
		const arrow = await lit('arrow-prop-lit')
		expect([arrow.fn?.kind, arrow.fn?.name]).toEqual(['arrow', 'handler'])
		const priv = await lit('private-lit')
		expect([priv.fn?.kind, priv.fn?.name]).toEqual(['method', '#secret'])
		const objMethod = await lit('obj-method-lit')
		expect([objMethod.fn?.kind, objMethod.fn?.name]).toEqual(['method', 'run'])
		const fnExpr = await lit('fn-expr-lit')
		expect([fnExpr.fn?.kind, fnExpr.fn?.name]).toEqual(['expression', 'fn'])
	})

	it('chains parents innermost first', async () => {
		const nested = await lit('nested-lit')
		expect(nested.fn?.name).toBe('inner')
		expect(nested.full.parents.map((f) => f.name)).toEqual(['outer'])
	})
})

describe('template literals', () => {
	const source = [
		'function render(user) {',
		'  return `hello ${user.name}, needle in the middle ${count} and the tail`',
		'}',
		'',
	].join('\n')

	it('indexes each static chunk, cites it, and does not match across a substitution', async () => {
		const tree = make({ 't.js': source })
		const p = provider()
		const root = tree.root
		const middle = ok(await p.findLiteral({ root, text: 'needle in the middle' }))
		expect(middle.value.total).toBe(1)
		const hit = middle.value.items[0]
		expect(hit?.kind).toBe('template')
		expect(hit?.function?.name).toBe('render')
		expect(hit?.line).toBe(2)
		// The template element's range lies inside the template literal.
		const literalStart = locate(source, '`hello').offset
		const literalEnd = source.lastIndexOf('`') + 1
		expect(hit?.start).toBeGreaterThanOrEqual(literalStart)
		expect(hit?.end).toBeLessThanOrEqual(literalEnd + 1)
		// "hello ... needle" spans a ${user.name}; the chunks are separate.
		expect(ok(await p.findLiteral({ root, text: 'hello user' })).value.total).toBe(0)
		expect(middle.evidence.inferred.join(' ')).toContain('static chunk')
		await p.dispose()
	})
})
