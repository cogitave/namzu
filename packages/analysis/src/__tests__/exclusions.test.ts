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

const reasons = (r: { evidence: { coverage: unknown } }): string =>
	JSON.stringify(r.evidence.coverage)

describe('coverage names what the index never looked at', () => {
	it('says a literal may sit in an ignored directory, with its name and count', async () => {
		const tree = make({
			'src/coverage/report.js': 'export const r = () => "coverage-dir-literal"\n',
			'src/ok.js': 'export const ok = () => "fine"\n',
			'lib/.cache/c.js': 'export const c = () => "dotcache-literal"\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'coverage-dir-literal' }))
		expect(r.value.total).toBe(0)
		expect(r.evidence.coverage.status).toBe('partial')
		expect(reasons(r)).toContain('ignored directories')
		expect(reasons(r)).toContain('coverage ×1')
		expect(reasons(r)).toContain('.cache ×1')
		await p.dispose()
	})

	it('is complete when nothing relevant was left out, node_modules included', async () => {
		const tree = make({
			'a.js': 'export const a = () => "x-literal"\n',
			'node_modules/dep/i.js': 'module.exports = () => "vendored"\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'x-literal' }))
		expect(r.evidence.coverage.status).toBe('complete')
		await p.dispose()
	})

	it('counts files in languages it does not parse, per extension', async () => {
		const tree = make({
			'a.js': 'export const a = () => "x-literal"\n',
			'page.html': '<script>var s = "html-inline-literal"</script>',
			'b.html': '<p></p>',
			'old.es6': 'export const e = () => "es6-literal"\n',
			'c.vue': '<script>export default {}</script>',
			'data.json': '{"json-literal": 1}',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'html-inline-literal' }))
		expect(r.value.total).toBe(0)
		expect(r.evidence.coverage.status).toBe('partial')
		expect(reasons(r)).toContain('.html ×2')
		expect(reasons(r)).toContain('.es6 ×1')
		expect(reasons(r)).toContain('.vue ×1')
		expect(reasons(r)).not.toContain('.json')
		await p.dispose()
	})

	it('counts declaration files', async () => {
		const tree = make({
			'a.ts': 'export const a = () => "x-literal"\n',
			'types/a.d.ts': 'export declare const a: string\n',
			'types/b.d.ts': 'export declare const b: string\n',
		})
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: 'x-literal' }))
		expect(r.evidence.coverage.status).toBe('partial')
		expect(reasons(r)).toContain('2 declaration file(s)')
		await p.dispose()
	})

	it('tells a question about one directory only about that directory', async () => {
		const tree = make({
			'a/x.js': 'export const x = () => "in-a"\n',
			'b/dist/y.js': 'export const y = () => "in-b-dist"\n',
			'b/z.js': 'export const z = () => "in-b"\n',
		})
		const p = provider()
		const a = ok(await p.findLiteral({ root: tree.root, text: 'in-a', path: tree.path('a') }))
		expect(a.evidence.coverage.status).toBe('complete')
		const b = ok(await p.findLiteral({ root: tree.root, text: 'in-b', path: tree.path('b') }))
		expect(reasons(b)).toContain('dist ×1')
		await p.dispose()
	})

	it('indexes an extension-less script that starts with a node, bun or deno shebang', async () => {
		const tree = make({
			'bin/mycli': '#!/usr/bin/env node\nfunction main() { return "shebang-extless-literal" }\n',
			'bin/bunny': '#!/usr/bin/env -S bun run\nexport const b = () => "bun-literal"\n',
			'bin/denoer': '#!/usr/bin/deno run\nexport const d = () => "deno-literal"\n',
			'bin/shell': '#!/bin/sh\necho "not-javascript"\n',
			LICENSE: 'MIT "license-literal"\n',
		})
		const p = provider()
		const root = tree.root
		for (const text of ['shebang-extless-literal', 'bun-literal', 'deno-literal']) {
			const r = ok(await p.findLiteral({ root, text }))
			expect(r.value.total, text).toBe(1)
		}
		expect(ok(await p.findLiteral({ root, text: 'not-javascript' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root, text: 'license-literal' })).value.total).toBe(0)
		const fn = ok(await p.functionSource({ root, path: tree.path('bin/mycli'), name: 'main' }))
		expect(fn.value.total).toBe(1)
		await p.dispose()
	})
})

describe('.gitignore and the default ignore list', () => {
	it('does not index what a root .gitignore or a nested one lists, and names it', async () => {
		const tree = make({
			'.gitignore': 'generated.js\n/tmp-out/\n',
			'generated.js': 'export const g = () => "gen-literal"\n',
			'tmp-out/o.js': 'export const o = () => "tmpout-literal"\n',
			'src/.gitignore': '*.bundle.js\n!keep.bundle.js\n',
			'src/a.bundle.js': 'export const a = () => "bundle-literal"\n',
			'src/keep.bundle.js': 'export const k = () => "kept-bundle-literal"\n',
			'src/real.js': 'export const r = () => "real-literal"\n',
		})
		const p = provider()
		const root = tree.root
		expect(ok(await p.findLiteral({ root, text: 'real-literal' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root, text: 'kept-bundle-literal' })).value.total).toBe(1)
		const none = ok(await p.findLiteral({ root, text: 'gen-literal' }))
		expect(none.value.total).toBe(0)
		expect(none.evidence.coverage.status).toBe('partial')
		expect(reasons(none)).toContain('.gitignore')
		expect(reasons(none)).toContain('tmp-out/ ×1')
		expect(ok(await p.findLiteral({ root, text: 'tmpout-literal' })).value.total).toBe(0)
		expect(ok(await p.findLiteral({ root, text: 'bundle-literal' })).value.total).toBe(1)
		await p.dispose()
	})

	it('can be told to ignore .gitignore', async () => {
		const tree = make({
			'.gitignore': 'generated.js\n',
			'generated.js': 'export const g = () => "gen-literal"\n',
		})
		const p = provider({ respectGitignore: false })
		expect(ok(await p.findLiteral({ root: tree.root, text: 'gen-literal' })).value.total).toBe(1)
		await p.dispose()
	})

	it('leaves build output out by default and indexes it when asked by path', async () => {
		const tree = make({
			'src/a.ts': 'export const a = () => "src-copy-literal"\n',
			'dist/a.js': 'export const a = () => "src-copy-literal"\n',
			'build/b.js': 'export const b = () => "build-literal"\n',
			'.next/n.js': 'export const n = () => "next-literal"\n',
			'out/o.js': 'export const o = () => "out-literal"\n',
		})
		const p = provider()
		const root = tree.root
		const all = ok(await p.findLiteral({ root, text: 'src-copy-literal' }))
		expect(all.value.total).toBe(1)
		for (const name of ['dist', 'build', '.next', 'out'])
			expect(reasons(all)).toContain(`${name} ×1`)
		ok(await p.index({ root, scope: tree.path('dist') }))
		const dist = ok(
			await p.findLiteral({ root, text: 'src-copy-literal', path: tree.path('dist') }),
		)
		expect(dist.value.total).toBe(1)
		await p.dispose()
	})
})

describe('the reason an index call stopped', () => {
	it('names the time limit and says to call again, not to narrow the path', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 5; i++) files[`f${i}.js`] = `export const f${i} = () => "lit-${i}"\n`
		const tree = make(files)
		const p = provider({ maxMillis: 0 })
		const out = ok(await p.index({ root: tree.root })).value
		expect(out.truncated).toContain('0 seconds')
		expect(out.truncated).not.toContain('directories')
		expect(out.truncated).toContain('again')
		expect(out.truncated).not.toContain('narrower path')
		await p.dispose()
	})

	it('names the directory limit and says to index a narrower path', async () => {
		const tree = make({
			'a/x.js': 'export const x = () => "lit-x"\n',
			'b/y.js': 'export const y = () => "lit-y"\n',
			'c/z.js': 'export const z = () => "lit-z"\n',
		})
		const p = provider({ maxDirectories: 2 })
		const out = ok(await p.index({ root: tree.root })).value
		expect(out.truncated).toContain('2 directories')
		expect(out.truncated).toContain('narrower path')
		expect(out.truncated).not.toContain('seconds')
		await p.dispose()
	})
})
