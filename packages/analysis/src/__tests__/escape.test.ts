import { mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

import { CodeAnalysisTool, type ToolContext } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { Tree, failure, ok, provider } from './helpers.js'

/**
 * The index must never answer from a file outside its root, even when a file
 * it indexed has since been replaced by a link. The walker skips links, so the
 * hole was on the read paths that run AFTER indexing.
 */

const trees: Tree[] = []
const make = (files: Record<string, string> = {}) => {
	const t = new Tree(files)
	trees.push(t)
	return t
}
afterEach(() => {
	for (const t of trees.splice(0)) t.dispose()
})

const SECRET = 'function leak(){ return "TOPSECRET-outside-root" }\n'

async function indexedProject() {
	const project = make({
		'a.js': 'function a(){ return "inside-literal" }\n',
		'keep.js': 'function keep(){ return 1 }\n',
	})
	const outside = make({ 'secret.js': SECRET, 'sub/deep.js': SECRET })
	const p = provider()
	ok(await p.index({ root: project.root }))
	const id = ok(
		await p.functionSource({ root: project.root, path: project.path('a.js'), name: 'a' }),
	).value.items[0]?.function.id as number
	return { project, outside, p, id }
}

describe('a file replaced by a link after it was indexed', () => {
	it('is not read through by function_source with an id', async () => {
		const { project, outside, p, id } = await indexedProject()
		rmSync(project.path('a.js'))
		symlinkSync(outside.path('secret.js'), project.path('a.js'))

		const reply = await p.functionSource({ root: project.root, id })
		const text = JSON.stringify(reply)
		expect(text).not.toContain('TOPSECRET')
		expect(reply.kind).toBe('failed')
		expect(failure(reply)).toMatch(/link|regular file|outside/)
		await p.dispose()
	})

	it('is not served by a path-less find_literal, cited as an in-root path', async () => {
		const { project, outside, p } = await indexedProject()
		rmSync(project.path('a.js'))
		symlinkSync(outside.path('secret.js'), project.path('a.js'))

		const reply = await p.findLiteral({ root: project.root, text: 'TOPSECRET' })
		expect(JSON.stringify(reply)).not.toContain('TOPSECRET-outside')
		expect(ok(reply).value.total).toBe(0)

		// The stale rows for that file are dropped, and the answer says so.
		const again = ok(await p.findLiteral({ root: project.root, text: 'inside-literal' }))
		expect(again.value.total).toBe(0)
		expect(JSON.stringify(again.evidence.coverage)).toMatch(/link|outside the root/)
		await p.dispose()
	})

	it('is not served by callers_of, enclosing_function or imports', async () => {
		const { project, outside, p } = await indexedProject()
		rmSync(project.path('a.js'))
		symlinkSync(outside.path('secret.js'), project.path('a.js'))

		const callers = await p.callersOf({ root: project.root, name: 'a', scope: 'workspace' })
		expect(JSON.stringify(callers)).not.toContain('TOPSECRET')
		const enclosing = await p.enclosingFunction({
			root: project.root,
			path: project.path('a.js'),
			line: 1,
			column: 20,
		})
		expect(JSON.stringify(enclosing)).not.toContain('TOPSECRET')
		expect(enclosing.kind).not.toBe('ok')
		const imports = await p.imports({ root: project.root, path: project.path('a.js') })
		expect(imports.kind).not.toBe('ok')
		await p.dispose()
	})

	it('is not followed when a whole directory is swapped for a link', async () => {
		const project = make({ 'dir/b.js': 'function b(){ return "dir-inside" }\n' })
		const outside = make({ 'sub/b.js': 'function b(){ return "TOPSECRET-dir" }\n' })
		const p = provider()
		ok(await p.index({ root: project.root }))
		rmSync(project.path('dir'), { recursive: true })
		mkdirSync(outside.path('sub'), { recursive: true })
		symlinkSync(outside.path('sub'), project.path('dir'))

		const reply = await p.functionSource({
			root: project.root,
			path: project.path('dir/b.js'),
			name: 'b',
		})
		expect(JSON.stringify(reply)).not.toContain('TOPSECRET')
		expect(reply.kind).not.toBe('ok')
		const hits = await p.findLiteral({ root: project.root, text: 'TOPSECRET' })
		expect(JSON.stringify(hits)).not.toContain('TOPSECRET-dir')
		await p.dispose()
	})

	it('is not followed by a refresh, which must not index the target either', async () => {
		const { project, outside, p } = await indexedProject()
		rmSync(project.path('a.js'))
		symlinkSync(outside.path('secret.js'), project.path('a.js'))
		const out = ok(await p.index({ root: project.root })).value
		expect(out.files.indexed).toBe(1)
		expect(ok(await p.findLiteral({ root: project.root, text: 'TOPSECRET' })).value.total).toBe(0)
		await p.dispose()
	})
})

describe('through the tool, with the real provider', () => {
	it('never prints the outside file', async () => {
		const { project, outside, p, id } = await indexedProject()
		rmSync(project.path('a.js'))
		symlinkSync(outside.path('secret.js'), project.path('a.js'))
		const ctx = { workingDirectory: project.root, codeAnalysis: p } as ToolContext
		for (const input of [
			{ operation: 'function_source', function_id: id },
			{ operation: 'find_literal', text: 'TOPSECRET' },
			{ operation: 'callers_of', name: 'x', scope: 'workspace' },
			{ operation: 'enclosing_function', path: 'a.js', line: 1, column: 20 },
		] as const) {
			const r = await CodeAnalysisTool.execute(input, ctx)
			expect(`${r.output}${r.error ?? ''}`).not.toContain('TOPSECRET-')
		}
		void join
		await p.dispose()
	})
})
