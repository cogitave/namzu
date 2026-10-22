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

/** A 25,000-character function with the literal of interest near its end. */
function bigFunction(): { text: string; line: number; column: number } {
	const filler = Array.from({ length: 1000 }, (_, i) => `  var v${i} = "filler-${i}";`).join('\n')
	const head = `function big() {\n${filler}\n`
	const line = head.split('\n').length
	const text = `${head}  return "showExternalIncludesDialog";\n${'  // tail\n'.repeat(60)}}\n`
	return { text, line, column: 11 }
}

describe('a function longer than max_chars is cut around the position', () => {
	it('enclosing_function returns a window that contains the cited position', async () => {
		const { text, line, column } = bigFunction()
		expect(text.length).toBeGreaterThan(20_000)
		const tree = make({ 'big.js': text })
		const p = provider()
		const r = ok(
			await p.enclosingFunction({ root: tree.root, path: tree.path('big.js'), line, column }),
		)
		const source = r.value.source
		expect(source?.truncated).toBe(true)
		expect(source?.text).toContain('showExternalIncludesDialog')
		expect(source?.text.startsWith('function big() {')).toBe(true)
		expect(source?.text).toContain('characters omitted')
		expect(source?.window).toBeDefined()
		const w = source?.window as { from: number; to: number }
		const offset = text.indexOf('showExternalIncludesDialog')
		expect(w.from <= offset && offset < w.to).toBe(true)
		expect((source?.text.length ?? 0) < 20_000 + 200).toBe(true)
		await p.dispose()
	})

	it('function_source with a position does the same, and without one cuts at the end', async () => {
		const { text, line, column } = bigFunction()
		const tree = make({ 'big.js': text })
		const p = provider()
		const root = tree.root
		const path = tree.path('big.js')
		const plain = ok(await p.functionSource({ root, path, name: 'big' }))
		expect(plain.value.items[0]?.source.text).not.toContain('showExternalIncludesDialog')
		expect(plain.value.items[0]?.source.window).toBeUndefined()
		const around = ok(await p.functionSource({ root, path, name: 'big', around: { line, column } }))
		expect(around.value.items[0]?.source.text).toContain('showExternalIncludesDialog')
		await p.dispose()
	})

	it('leaves a function that fits whole, and never splits a surrogate pair', async () => {
		const body = `${'😀'.repeat(300)}\n"needle"\n${'😀'.repeat(300)}`
		const tree = make({ 'a.js': `function f() {\n${body}\n}\n`.replace(/😀/g, '"😀";') })
		const p = provider()
		const r = ok(
			await p.enclosingFunction({
				root: tree.root,
				path: tree.path('a.js'),
				line: 3,
				column: 2,
				maxChars: 300,
			}),
		)
		const t = r.value.source?.text ?? ''
		expect(t).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
		expect(t).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/)
		await p.dispose()
	})
})
