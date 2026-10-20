import { afterEach, describe, expect, it, vi } from 'vitest'

import { Tree, failure, provider } from './helpers.js'

// The parser's native binary is missing for this platform: importing it throws.
vi.mock('oxc-parser', () => {
	throw new Error('Cannot find native binding @oxc-parser/binding-test')
})

const trees: Tree[] = []
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

describe('a parser that cannot be loaded', () => {
	it('is "unsupported", naming the cause, on every operation, never an empty index', async () => {
		const tree = new Tree({ 'a.js': 'function a(){return "x"}' })
		trees.push(tree)
		const p = provider()
		const reply = await p.findLiteral({ root: tree.root, text: 'x' })
		expect(reply.kind).toBe('unsupported')
		expect(failure(reply)).toContain('oxc-parser')
		expect(failure(await p.index({ root: tree.root }))).toContain('could not be loaded')
		// Nothing was recorded as a per-file "parser failure": the index is not
		// half-built, it was never built.
		expect((await p.index({ root: tree.root })).kind).toBe('unsupported')
		await p.dispose()
	})
})
