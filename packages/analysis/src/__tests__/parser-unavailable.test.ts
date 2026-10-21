import { afterEach, describe, expect, it } from 'vitest'

import { Tree, failure, provider } from './helpers.js'

const trees: Tree[] = []
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
	Reflect.deleteProperty(process.env, 'NAMZU_ANALYSIS_PARSER')
})

describe('a parser that cannot be loaded', () => {
	it('is "unsupported", naming the cause, never an empty index', async () => {
		const tree = new Tree({ 'a.js': 'function a(){return "x"}' })
		trees.push(tree)
		// The parser lives in a child process, which a module mock cannot reach;
		// the child reads this to decide what to load.
		process.env.NAMZU_ANALYSIS_PARSER = 'a-parser-that-is-not-installed'
		const p = provider()
		const reply = await p.findLiteral({ root: tree.root, text: 'x' })
		expect(reply.kind).toBe('unsupported')
		expect(failure(reply)).toContain('could not be loaded')
		expect((await p.index({ root: tree.root })).kind).toBe('unsupported')
		await p.dispose()
	})
})
