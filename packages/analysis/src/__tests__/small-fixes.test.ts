import { afterEach, describe, expect, it } from 'vitest'

import { Tree, ok, provider } from './helpers.js'

const trees: Tree[] = []
const make = (files: Record<string, string>) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

describe('find_literal with the substring index', () => {
	it('finds a two-code-point needle that is four UTF-16 units long', async () => {
		const tree = make({ 'a.js': 'function a(){ return "x😀😀y" }\n' })
		const p = provider()
		const r = ok(await p.findLiteral({ root: tree.root, text: '😀😀' }))
		expect(r.value.total).toBe(1)
		expect(r.evidence.coverage.status).toBe('complete')
		await p.dispose()
	})

	it('finds one- and three-code-point needles of astral characters', async () => {
		const tree = make({ 'a.js': 'function a(){ return "😀😀😀 z" }\n' })
		const p = provider()
		expect(ok(await p.findLiteral({ root: tree.root, text: '😀' })).value.total).toBe(1)
		expect(ok(await p.findLiteral({ root: tree.root, text: '😀😀😀' })).value.total).toBe(1)
		await p.dispose()
	})
})
