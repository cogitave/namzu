import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

const trees: Tree[] = []
const make = (files: Record<string, string | Uint8Array> = {}) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const around = (name: string, bad: string) =>
	`function ok1() { return "${name}-before"; }\n${bad}\nfunction ok2() { return "${name}-after"; }\n`

describe('a syntax error costs the lines it is on, not the file', () => {
	const cases: [string, string, string][] = [
		['e1.js', 'e1', 'const x = ;'],
		['e2.js', 'e2', 'let a = 1 2;'],
		['e3.js', 'e3', 'foo(;'],
		['e6.js', 'e6', 'class { }'],
		['e7.ts', 'e7', '}'],
	]
	for (const [file, name, bad] of cases) {
		it(`keeps the functions and strings on both sides of ${JSON.stringify(bad)} in ${file}`, async () => {
			const tree = make({ [file]: around(name, bad) })
			const p = provider()
			const root = tree.root
			const before = ok(await p.findLiteral({ root, text: `${name}-before` }))
			const after = ok(await p.findLiteral({ root, text: `${name}-after` }))
			expect(before.value.total).toBe(1)
			expect(after.value.total).toBe(1)
			expect(before.value.items[0]?.function?.name).toBe('ok1')
			expect(after.value.items[0]?.function?.name).toBe('ok2')
			// The positions are the file's own.
			expect(after.value.items[0]?.line).toBe(3)
			const fn = ok(await p.functionSource({ root, path: tree.path(file), name: 'ok2' }))
			expect(fn.value.items[0]?.source.text).toBe(`function ok2() { return "${name}-after"; }`)
			if (name !== 'e6') {
				expect(before.evidence.coverage.status).toBe('partial')
				expect(JSON.stringify(before.evidence.coverage)).toContain('syntax errors')
			}
			await p.dispose()
		})
	}

	it('reads a Flow-annotated .js file as TypeScript', async () => {
		const tree = make({
			'flow.js':
				'// @flow\nfunction f(a: string): number { return "flow-lit"; }\nexport type T = { a: number };\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'flow-lit' }))
		expect(r.value.total).toBe(1)
		expect(r.value.items[0]?.function?.name).toBe('f')
		await p.dispose()
	})

	it('reads annotations in a .js file with no pragma too', async () => {
		const tree = make({ 'ann.js': 'function g(a: number, b?: string) { return "ann-lit"; }\n' })
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'ann-lit' }))
		expect(r.value.total).toBe(1)
		await p.dispose()
	})

	it('falls back to a tolerant scan of a file with a bad line in the middle of a statement', async () => {
		// Half of this file is the broken part, so blanking lines is not trusted.
		const text =
			'function ok1() { return "scan-before"; }\nfoo(; bar(; baz(;\nfunction ok2() { return "scan-after"; }\nconst t = `tpl ${a} chunk-two`;'
		const tree = make({
			'bad.js': text
				.replace('foo(; bar(; baz(;', 'foo(( ((( [[ {{ ;;;( ((((')
				.padEnd(text.length + 600, ' '),
		})
		const p = provider()
		const root = tree.root
		const r = ok(await p.findLiteral({ root, text: 'scan-after' }))
		expect(r.value.total).toBe(1)
		expect(ok(await p.findLiteral({ root, text: 'chunk-two' })).value.total).toBe(1)
		await p.dispose()
	})

	it('marks a scanned file degraded in coverage and finds its function anchors', async () => {
		// One line, so repairing means blanking everything: the scanner takes over.
		const tree = make({
			'min.js':
				'function a(){return "min-a"}function b(){return "min-b"}foo(;function c(){return "min-c"}',
		})
		const p = provider()
		const root = tree.root
		const r = ok(await p.findLiteral({ root, text: 'min-c' }))
		expect(r.value.total).toBe(1)
		expect(r.value.items[0]?.function?.name).toBe('c')
		expect(JSON.stringify(r.evidence.coverage)).toContain('tolerant scan')
		const fn = ok(await p.functionSource({ root, path: tree.path('min.js'), name: 'b' }))
		expect(fn.value.items[0]?.source.text).toBe('function b(){return "min-b"}')
		expect(JSON.stringify(fn.evidence.coverage)).toContain('tolerant scan')
		await p.dispose()
	})
})
