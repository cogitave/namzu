import { execFileSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import { collect } from '../collect.js'
import { DEFAULT_IGNORED_DIRS, toRel } from '../indexer.js'
import { Tree, failure, ok, provider } from './helpers.js'

const trees: Tree[] = []
const make = (files: Record<string, string> = {}) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const T0 = 1_700_000_000
const status = (r: { evidence: { coverage: { status: string } } }) => r.evidence.coverage.status
const cov = (r: { evidence: { coverage: unknown } }) => JSON.stringify(r.evidence.coverage)
const obs = (r: { evidence: { observed: readonly string[] } }) => r.evidence.observed.join('\n')

describe('coverage: what cannot hide an answer is a note, not a gap', () => {
	it('find_literal stays complete with node_modules, a build dir, .d.ts and a gitignored directory', async () => {
		const tree = make({
			'package.json': '{}',
			'.gitignore': 'gen/\n',
			'src/a.ts': 'export const a = () => "needle-one"\n',
			'node_modules/x/i.js': 'module.exports = "needle-two"\n',
			'dist/a.js': 'exports.a = "needle-three"\n',
			'types/a.d.ts': 'export declare const a: string\n',
			'gen/g.js': 'export const g = "needle-four"\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'needle-one' }))
		expect(r.value.total).toBe(1)
		expect(status(r)).toBe('complete')
		const none = ok(await p.findLiteral({ root: tree.root, text: 'needle-four' }))
		expect(none.value.total).toBe(0)
		expect(status(none)).toBe('complete')
		expect(obs(none)).toContain('node_modules ×1')
		expect(obs(none)).toContain('dist ×1')
		expect(obs(none)).toContain('gen/ ×1')
		expect(obs(none)).toContain('1 declaration file(s)')
		await p.dispose()
	})

	it('a gitignored source FILE is still a gap', async () => {
		const tree = make({
			'.gitignore': 'gen.js\n',
			'a.js': 'export const a = "x-lit"\n',
			'gen.js': 'export const g = "gen-lit"\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'gen-lit' }))
		expect(status(r)).toBe('partial')
		expect(cov(r)).toContain('gen.js ×1')
		await p.dispose()
	})

	it('an unparsed file that may hold JavaScript is a gap', async () => {
		const tree = make({
			'a.js': 'export const a = "x-lit"\n',
			'p.html': '<script>var s="in-html"</script>',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'in-html' }))
		expect(status(r)).toBe('partial')
		expect(cov(r)).toContain('.html ×1')
		await p.dispose()
	})

	it('cut literals are a gap for a needle longer than one character and not for one character', async () => {
		const tree = make({
			'a.js': `export const big = "${'a'.repeat(10_000)}${'b'.repeat(10_000)}"\n`,
		})
		const p = provider()
		const long = ok(await p.findLiteral({ root: tree.root, text: 'ab' }))
		expect(status(long)).toBe('partial')
		expect(cov(long)).toContain('longer than 8192')
		const one = ok(await p.findLiteral({ root: tree.root, text: 'a' }))
		expect(status(one)).toBe('complete')
		await p.dispose()
	})

	it('a degraded or crashed file only matters to a question about its own path', async () => {
		const tree = make({
			'bad/b.js':
				'function ok1() { return "x1"; }\nfoo(( ((( [[ {{ ;;;( ((((\nfunction ok2() { return "x2"; }\n',
			'good/g.js': 'export const g = () => "good-lit"\n',
		})
		const p = provider()
		const root = tree.root
		const whole = ok(await p.findLiteral({ root, text: 'good-lit' }))
		expect(status(whole)).toBe('partial')
		expect(cov(whole)).toContain('syntax errors')
		const scoped = ok(await p.findLiteral({ root, text: 'good-lit', path: tree.path('good') }))
		expect(scoped.value.total).toBe(1)
		expect(status(scoped)).toBe('complete')
		await p.dispose()
	})

	it('single-file operations depend on their own file only', async () => {
		const tree = make({
			'.gitignore': 'gen.js\n',
			'gen.js': 'export const g = 1\n',
			'p.html': '<p></p>',
			'a.js': 'export function f() {\n  return "x"\n}\n',
		})
		const p = provider()
		const root = tree.root
		const path = tree.path('a.js')
		expect(status(ok(await p.enclosingFunction({ root, path, line: 2 })))).toBe('complete')
		expect(status(ok(await p.functionSource({ root, path, name: 'f' })))).toBe('complete')
		expect(status(ok(await p.imports({ root, path })))).toBe('complete')
		await p.dispose()
	})

	it('a Flow file that parsed cleanly as TypeScript is not reported as having syntax errors', async () => {
		const tree = make({
			'flow.js':
				'// @flow\nfunction f(a: string): number { return "flow-lit"; }\nexport type T = { a: number };\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'flow-lit' }))
		expect(r.value.total).toBe(1)
		expect(status(r)).toBe('complete')
		expect(cov(r)).not.toContain('syntax errors')
		const idx = ok(await p.index({ root: tree.root, force: true }))
		expect(idx.value.files.withParseErrors).toBe(0)
		await p.dispose()
	})
})

describe('callers_of and a computed callee', () => {
	const many = (calls: number, computed: number): string => {
		const lines = ['function target() {}']
		for (let i = 0; i < calls; i++) lines.push('noop();')
		for (let i = 0; i < computed; i++) lines.push('fns[0]();')
		return `${lines.join('\n')}\n`
	}

	it('with no static call found, a computed callee makes the answer partial', async () => {
		const tree = make({ 'a.js': many(10, 1) })
		const p = provider()
		const r = ok(await p.callersOf({ root: tree.root, name: 'target', scope: 'workspace' }))
		expect(r.value.total).toBe(0)
		expect(status(r)).toBe('partial')
		expect(cov(r)).toContain(
			'no static call to \\"target\\" found; 1 call(s) in scope use a computed callee',
		)
		expect(obs(r)).toContain('1 of 11 calls in scope use a computed callee')
		await p.dispose()
	})

	it('with a static call found and few computed ones, the count is observed and the answer complete', async () => {
		const tree = make({ 'a.js': `${many(40, 1)}target();\n` })
		const p = provider()
		const r = ok(await p.callersOf({ root: tree.root, name: 'target', scope: 'workspace' }))
		expect(r.value.total).toBe(1)
		expect(status(r)).toBe('complete')
		expect(obs(r)).toContain('1 of 42 calls in scope use a computed callee')
		await p.dispose()
	})

	it('five per cent or more computed callees is partial even with a hit', async () => {
		const tree = make({ 'a.js': `${many(18, 2)}target();\n` })
		const p = provider()
		const r = ok(await p.callersOf({ root: tree.root, name: 'target', scope: 'workspace' }))
		expect(r.value.total).toBe(1)
		expect(status(r)).toBe('partial')
		await p.dispose()
	})

	it('ignores gitignored directories and build output like find_literal does', async () => {
		const tree = make({
			'package.json': '{}',
			'.gitignore': 'gen/\n',
			'a.js': 'function target() {}\ntarget();\n',
			'dist/b.js': 'target();\n',
			'gen/c.js': 'target();\n',
		})
		const p = provider()
		const r = ok(await p.callersOf({ root: tree.root, name: 'target', scope: 'workspace' }))
		expect(status(r)).toBe('complete')
		expect(obs(r)).toContain('dist ×1')
		await p.dispose()
	})
})

describe('the cut marker cannot be searched for', () => {
	it("findLiteral('…') on a cut literal finds nothing", async () => {
		const tree = make({
			'a.js': `export const big = "${'a'.repeat(10_000)}${'b'.repeat(10_000)}"\n`,
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: '…' }))
		expect(r.value.total).toBe(0)
		await p.dispose()
	})

	it('rejects a needle that holds a control character of the marker', async () => {
		const tree = make({ 'a.js': 'export const a = "x"\n' })
		const p = provider()
		expect(failure(await p.findLiteral({ root: tree.root, text: 'a\u0001b' }))).toContain('U+0001')
		await p.dispose()
	})
})

describe('private callees', () => {
	const src = `export class A {
  #p() { return "private" }
  p() { return "public" }
  run() { this.#p(); }
  other() { this.p(); }
}
`
	it('callersOf("A.#p") finds this.#p() and not the public p', async () => {
		const tree = make({ 'a.js': src })
		const p = provider()
		const root = tree.root
		const priv = ok(await p.callersOf({ root, name: 'A.#p', path: tree.path('a.js') }))
		expect(priv.value.items.map((i) => [i.line, i.callee])).toEqual([[4, 'this.#p']])
		const pub = ok(await p.callersOf({ root, name: 'A.p', path: tree.path('a.js') }))
		expect(pub.value.items.map((i) => [i.line, i.callee])).toEqual([[5, 'this.p']])
		await p.dispose()
	})
})

describe('a new extension-less shebang script named as the scope', () => {
	it('is indexed on the first query', async () => {
		const tree = make({ 'a.js': 'export const a = "a-lit"\n' })
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('tool2', '#!/usr/bin/env node\nconsole.log("sb2-lit")\n')
		const r = ok(await p.findLiteral({ root, path: tree.path('tool2'), text: 'sb2-lit' }))
		expect(r.value.total).toBe(1)
		tree.write('plain', '#!/bin/sh\necho "sh-lit"\n')
		const sh = ok(await p.findLiteral({ root, path: tree.path('plain'), text: 'sh-lit' }))
		expect(sh.value.total).toBe(0)
		await p.dispose()
	})
})

describe('a changed directory refreshes its own entries only', () => {
	const options = {
		ignoreDirs: DEFAULT_IGNORED_DIRS,
		maxFileBytes: 1 << 20,
		maxFiles: 1000,
		maxDirectories: 1000,
		maxMillis: 60_000,
		force: false,
	}
	const budget = () => ({ started: performance.now(), options, signal: undefined })

	it('the walk lists the start and walks only the subdirectories that are new', async () => {
		const tree = make({ 'a.js': 'x', 'old/o.js': 'x', 'old/deep/d.js': 'x', 'fresh/f.js': 'x' })
		const known = new Set(['old', 'gone'])
		const walk = await collect(tree.root, tree.root, budget(), () => {}, known)
		expect(walk.files.map((f) => f.rel)).toEqual(['a.js', 'fresh/f.js'])
		expect(walk.dirs.map((d) => d.rel).sort()).toEqual(['', 'fresh'])
		expect(walk.vanished).toEqual(['gone'])
		expect(toRel(tree.root, tree.root)).toBe('')
	})

	it('finds a new root file, a new nested directory, and drops a removed one', async () => {
		const tree = make({
			'src/a.js': 'export const a = "alpha"\n',
			'src/sub/b.js': 'export const b = "beta"\n',
		})
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('root.js', 'export const r = "rootlit"\n')
		expect(ok(await p.findLiteral({ root, text: 'rootlit' })).value.total).toBe(1)
		tree.write('src/deep/er/c.js', 'export const c = "deeplit"\n')
		expect(ok(await p.findLiteral({ root, text: 'deeplit' })).value.total).toBe(1)
		tree.remove('src/sub')
		expect(ok(await p.findLiteral({ root, text: 'beta' })).value.total).toBe(0)
		tree.remove('src/deep')
		expect(ok(await p.findLiteral({ root, text: 'deeplit' })).value.total).toBe(0)
		// Nothing is left to re-read.
		const again = ok(await p.findLiteral({ root, text: 'deeplit' }))
		expect(obs(again)).not.toContain('re-read')
		await p.dispose()
	})

	it('an edit in a nested directory is still found after the root changed too', async () => {
		const tree = make({ 'src/sub/b.js': 'export const b = "beta-v1"\n' })
		tree.write('src/sub/b.js', 'export const b = "beta-v1"\n', T0)
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('root.js', 'export const r = 1\n')
		tree.write('src/sub/c.js', 'export const c = "gamma"\n')
		expect(ok(await p.findLiteral({ root, text: 'gamma' })).value.total).toBe(1)
		await p.dispose()
	})
})

describe('names that look like build output', () => {
	it('indexes src/build/ source, ignores build/ beside a package.json, and always ignores .next', async () => {
		const tree = make({
			'package.json': '{}',
			'src/build/b.js': 'export const b = "src-build-lit"\n',
			'build/o.js': 'export const o = "root-build-lit"\n',
			'.next/n.js': 'export const n = "next-lit"\n',
			'lib/.next/n.js': 'export const n = "libnext-lit"\n',
		})
		const p = provider()
		const root = tree.root
		expect(ok(await p.findLiteral({ root, text: 'src-build-lit' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root, text: 'root-build-lit' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root, text: 'next-lit' })).value.total).toBe(0)
		await p.dispose()
	})

	it('ignores a dist that a .gitignore lists even with no package.json beside it', async () => {
		const tree = make({
			'.gitignore': 'dist/\n',
			'dist/o.js': 'export const o = "root-dist-lit"\n',
			'src/dist/s.js': 'export const s = "nested-dist-lit"\n',
		})
		const p = provider()
		const root = tree.root
		// The root `dist` is listed by the .gitignore; `src/dist` is source: it has
		// no package.json beside it and nothing lists it... except that `dist/` in a
		// root .gitignore matches at any depth, so both are left out and noted.
		expect(ok(await p.findLiteral({ root, text: 'root-dist-lit' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root, text: 'nested-dist-lit' })).value.total).toBe(0)
		await p.dispose()
	})
})

describe('hostile inputs to the walk', () => {
	it('does not read a .gitignore that is a symbolic link', async () => {
		const outside = make({ rules: 'a.js\n' })
		const tree = make({ 'a.js': 'export const a = "link-rule-lit"\n' })
		symlinkSync(outside.path('rules'), tree.path('.gitignore'))
		const p = provider()
		expect(ok(await p.findLiteral({ root: tree.root, text: 'link-rule-lit' })).value.total).toBe(1)
		await p.dispose()
	})

	it('survives ignore patterns that are huge, malformed or backtracking-shaped', async () => {
		const lines = [
			'(a+)+$',
			'[',
			'\\',
			'!',
			'***/**/***',
			`${'a/'.repeat(5000)}x`,
			'x'.repeat(100_000),
		]
		for (let i = 0; i < 5000; i++) lines.push(`pattern-${i}/*/*.js`)
		const tree = make({
			'.gitignore': lines.join('\n'),
			'a.js': 'export const a = "hostile-lit"\n',
		})
		const p = provider()
		expect(ok(await p.findLiteral({ root: tree.root, text: 'hostile-lit' })).value.total).toBe(1)
		await p.dispose()
	})

	it('keeps the usable rules of a .gitignore that holds an unusable one', async () => {
		const tree = make({
			'.gitignore': `${'x'.repeat(100_000)}\ngenerated.js\n`,
			'generated.js': 'export const g = "gen-hostile"\n',
			'a.js': 'export const a = "hostile-lit-2"\n',
		})
		const p = provider()
		expect(ok(await p.findLiteral({ root: tree.root, text: 'hostile-lit-2' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root: tree.root, text: 'gen-hostile' })).value.total).toBe(0)
		await p.dispose()
	})

	it('does not open a FIFO named like a shebang script', async () => {
		const tree = make({
			'bin/real': '#!/usr/bin/env node\nconsole.log("real-sb-lit")\n',
			'a.js': 'export const a = 1\n',
		})
		execFileSync('mkfifo', [tree.path('bin/cli')])
		const p = provider()
		const root = tree.root
		// The walk must come back, and the FIFO is not a candidate.
		const idx = ok(await p.index({ root }))
		expect(idx.value.files.indexed).toBe(2)
		const named = ok(await p.findLiteral({ root, path: tree.path('bin/cli'), text: 'x' }))
		expect(named.value.total).toBe(0)
		await p.dispose()
	})
})
