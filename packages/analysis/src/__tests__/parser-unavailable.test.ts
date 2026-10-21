import { afterEach, describe, expect, it } from 'vitest'

import { Tree, failure, provider } from './helpers.js'

const trees: Tree[] = []
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

describe('a parser that cannot be loaded', () => {
	it('is "unsupported", naming the cause, never an empty index', async () => {
		const tree = new Tree({ 'a.js': 'function a(){return "x"}' })
		trees.push(tree)
		// The host names the module; the child loads it from its argument.
		const p = provider({ parserModule: 'a-parser-that-is-not-installed' })
		const reply = await p.findLiteral({ root: tree.root, text: 'x' })
		expect(reply.kind).toBe('unsupported')
		expect(failure(reply)).toContain('could not be loaded')
		expect((await p.index({ root: tree.root })).kind).toBe('unsupported')
		await p.dispose()
	})

	it('is not steered by the environment', async () => {
		const tree = new Tree({ 'a.js': 'function a(){return "x"}' })
		trees.push(tree)
		process.env.NAMZU_ANALYSIS_PARSER = 'a-parser-that-is-not-installed'
		try {
			const p = provider()
			expect((await p.findLiteral({ root: tree.root, text: 'x' })).kind).toBe('ok')
			await p.dispose()
		} finally {
			Reflect.deleteProperty(process.env, 'NAMZU_ANALYSIS_PARSER')
		}
	})
})
