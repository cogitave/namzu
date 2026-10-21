import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

/**
 * A parse that kills the parsing child costs that file, never the caller.
 *
 * oxc-parser 0.155.0 segfaults the process on a handful of pathological
 * inputs (`PATHOLOGICAL` below), in raw transfer and in the eager parse alike.
 * A segfault is not an exception and a worker thread does not isolate it, so
 * parsing runs in a child process. Which of these inputs crash is not the same
 * on every machine: all four on this project's development machines, one of
 * the four on a GitHub runner (measured on the Node 24 leg of #632). So the
 * bookkeeping is tested with a stand-in parser that dies on a marker every
 * time, and the real inputs are tested for what holds wherever they run.
 */

const trees: Tree[] = []
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const crashingParser = fileURLToPath(new URL('../__fixtures__/crash-parser.mjs', import.meta.url))
const MARKER = 'kill-the-parsing-child'

const PATHOLOGICAL: Record<string, string> = {
	'deep-array.js': `${'['.repeat(6000)}${']'.repeat(6000)}`,
	'ternaries.js': `x = ${Array.from({ length: 20_000 }, (_, i) => `c${i} ? ${i} :`).join(' ')} 0`,
	'plus-terms.js': `x = ${Array.from({ length: 100_000 }, () => '"a"').join('+')}`,
	'nested-calls.js': `${'f('.repeat(100_000)}${')'.repeat(100_000)}`,
}

const GOOD = {
	'before.js': 'function before(){ return "found-before" }\n',
	'zafter.js': 'function after(){ return "found-after" }\n',
}

function crashedCount(skippedReasons: Record<string, number>): number {
	return Object.entries(skippedReasons)
		.filter(([why]) => /crash/.test(why))
		.reduce((sum, [, n]) => sum + n, 0)
}

describe('indexing a tree that holds files the parser dies on', () => {
	it('completes, keeps the parent alive, records the crashers, and indexes everything else', async () => {
		const tree = new Tree({
			...GOOD,
			'm-crash.js': `// ${MARKER}\nfunction m(){}\n`,
			'n-crash.js': `const n = "${MARKER}"\n`,
		})
		trees.push(tree)
		const p = provider({ parserModule: crashingParser })
		const out = ok(await p.index({ root: tree.root }))

		// Two good files, and the two crashers recorded with no rows.
		expect(out.value.files.indexed).toBe(4)
		expect(crashedCount(out.value.skippedReasons)).toBe(2)
		expect(out.evidence.coverage.status).toBe('partial')
		expect(JSON.stringify(out.evidence.coverage)).toMatch(/crash/)

		expect(ok(await p.findLiteral({ root: tree.root, text: 'found-before' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root: tree.root, text: 'found-after' })).value.total).toBe(1)
		await p.dispose()
	}, 60_000)

	it('does not retry a crasher on the next refresh', async () => {
		const tree = new Tree({
			'ok.js': 'function ok1(){ return 1 }\n',
			'crash.js': `// ${MARKER}\n`,
		})
		trees.push(tree)
		const p = provider({ parserModule: crashingParser })
		ok(await p.index({ root: tree.root }))
		const again = ok(await p.index({ root: tree.root })).value
		expect(again.files.parsed).toBe(0)
		await p.dispose()
	}, 60_000)

	it('accounts for every real pathological input, crashed or parsed, and loses no good file', async () => {
		const tree = new Tree({ ...GOOD, ...PATHOLOGICAL })
		trees.push(tree)
		const p = provider()
		const out = ok(await p.index({ root: tree.root }))
		const { files, skippedReasons, truncated } = out.value
		const seen = JSON.stringify({ files, skippedReasons, truncated })

		expect(truncated, seen).toBeUndefined()
		expect(files.indexed, seen).toBe(6)
		if (crashedCount(skippedReasons) > 0) {
			expect(out.evidence.coverage.status).toBe('partial')
		}
		expect(ok(await p.findLiteral({ root: tree.root, text: 'found-before' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root: tree.root, text: 'found-after' })).value.total).toBe(1)
		await p.dispose()
	}, 120_000)
})
