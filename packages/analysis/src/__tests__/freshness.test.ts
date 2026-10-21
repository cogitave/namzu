import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

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

describe('a negative answer is checked against the files as they are now', () => {
	it('finds a literal added by an edit made after the index, with no index call between', async () => {
		const tree = make({ 'a.js': 'function alpha() { return "alpha-v1"; }\n' })
		tree.write('a.js', 'function alpha() { return "alpha-v1"; }\n', T0)
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('a.js', 'function alpha() { return "alpha-v2-longer"; }\nalpha();\n', T0 + 10)
		const r = ok(await p.findLiteral({ root, text: 'alpha-v2' }))
		expect(r.value.total).toBe(1)
		expect(r.evidence.observed.join(' ')).toContain('re-read')
		const old = ok(await p.findLiteral({ root, text: 'alpha-v1' }))
		expect(old.value.total).toBe(0)
		await p.dispose()
	})

	it('finds a caller added to an edited file by a workspace search', async () => {
		const tree = make({ 'a.js': 'function alpha() { return 1 }\n', 'b.js': 'export const b = 1\n' })
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('a.js', 'function alpha() { return 1 }\nbeta2();\n', T0 + 10)
		const r = ok(await p.callersOf({ root, name: 'beta2', scope: 'workspace' }))
		expect(r.value.total).toBe(1)
		await p.dispose()
	})

	it('finds a file created in an already-indexed directory', async () => {
		const tree = make({ 'src/a.js': 'export const a = () => "kept"\n' })
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('src/new.js', 'export const g = () => "gamma-new"\n', T0 + 50)
		// A directory's mtime moves when an entry is added; pin it so the check
		// does not depend on the clock's granularity.
		const r = ok(await p.findLiteral({ root, text: 'gamma-new' }))
		expect(r.value.total).toBe(1)
		await p.dispose()
	})

	it('finds a file in a directory created after the index', async () => {
		const tree = make({ 'a.js': 'export const a = () => "kept"\n' })
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.write('deep/er/c.js', 'export const c = () => "delta-new"\n', T0 + 50)
		const r = ok(await p.findLiteral({ root, text: 'delta-new' }))
		expect(r.value.total).toBe(1)
		await p.dispose()
	})

	it('stops reporting a literal from a file that was deleted', async () => {
		const tree = make({
			'a.js': 'export const a = () => "bye-bye"\n',
			'b.js': 'export const b = 1\n',
		})
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		tree.remove('a.js')
		const r = ok(await p.findLiteral({ root, text: 'bye-bye' }))
		expect(r.value.total).toBe(0)
		await p.dispose()
	})

	it('reports partial instead of re-reading when many files changed', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 30; i++) files[`f${i}.js`] = `export const f${i} = () => "orig-${i}"\n`
		const tree = make(files)
		const p = provider()
		const root = tree.root
		ok(await p.index({ root }))
		for (let i = 0; i < 30; i++)
			tree.write(`f${i}.js`, `export const f${i} = () => "changed-${i}-longer"\n`, T0 + 10)
		const r = ok(await p.findLiteral({ root, text: 'changed-3-' }))
		expect(r.value.total).toBe(0)
		expect(r.evidence.coverage.status).toBe('partial')
		// What the index does still hold is marked, as it always was.
		const old = ok(await p.findLiteral({ root, text: 'orig-3' }))
		expect(old.value.items[0]?.stale).toBe('changed')
		expect(JSON.stringify(r.evidence.coverage)).toContain('30 file(s) changed since indexing')
		// The index operation is the remedy it names.
		ok(await p.index({ root }))
		const after = ok(await p.findLiteral({ root, text: 'changed-3-' }))
		expect(after.value.total).toBe(1)
		await p.dispose()
	})
})
