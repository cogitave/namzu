import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

/**
 * oxc-parser 0.155.0 segfaults the process on a handful of pathological
 * inputs, in raw transfer and in the eager parse alike. A segfault is not an
 * exception and a worker thread does not isolate it, so parsing runs in a
 * child process. These inputs would kill this test run if they were parsed
 * in-process.
 */

const trees: Tree[] = []
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const CRASHERS: Record<string, string> = {
	'deep-array.js': `${'['.repeat(6000)}${']'.repeat(6000)}`,
	'ternaries.js': `x = ${Array.from({ length: 20_000 }, (_, i) => `c${i} ? ${i} :`).join(' ')} 0`,
	'plus-terms.js': `x = ${Array.from({ length: 100_000 }, () => '"a"').join('+')}`,
	'nested-calls.js': `${'f('.repeat(100_000)}${')'.repeat(100_000)}`,
}

describe('indexing a tree that holds parser-crashing files', () => {
	it('completes, keeps the parent alive, records the crashers, and indexes everything else', async () => {
		const tree = new Tree({
			'before.js': 'function before(){ return "found-before" }\n',
			...CRASHERS,
			'zafter.js': 'function after(){ return "found-after" }\n',
		})
		trees.push(tree)
		const p = provider()
		const out = ok(await p.index({ root: tree.root }))

		// Two good files, and the four crashers recorded with no rows.
		expect(out.value.files.indexed).toBe(6)
		const crashed = Object.entries(out.value.skippedReasons).find(([why]) => /crash/.test(why))
		expect(crashed?.[1]).toBe(4)
		expect(out.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(out.evidence.coverage)).toMatch(/crash/)

		expect(ok(await p.findLiteral({ root: tree.root, text: 'found-before' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root: tree.root, text: 'found-after' })).value.total).toBe(1)
		await p.dispose()
	}, 120_000)

	it('does not retry a crasher on the next refresh', async () => {
		const tree = new Tree({
			'ok.js': 'function ok1(){ return 1 }\n',
			'deep-array.js': CRASHERS['deep-array.js'] as string,
		})
		trees.push(tree)
		const p = provider()
		ok(await p.index({ root: tree.root }))
		const again = ok(await p.index({ root: tree.root })).value
		expect(again.files.parsed).toBe(0)
		await p.dispose()
	}, 120_000)
})
