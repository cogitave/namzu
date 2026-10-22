import { fileURLToPath } from 'node:url'

import { CodeAnalysisTool, type ToolContext, getCodeAnalysisTools } from '@namzu/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCodeAnalysisProvider } from '../provider.js'
import { Tree, ok } from './helpers.js'

/**
 * A small real tree, indexed once, asked every question — directly, and then
 * through the SDK tool with the real provider behind it, which is the path a
 * host takes.
 */

const APP = fileURLToPath(new URL('../__fixtures__/app', import.meta.url))
const at = (rel: string) => `${APP}/${rel}`

const cache = new Tree()
const provider = createCodeAnalysisProvider({ cacheDir: cache.root })

beforeAll(async () => {
	ok(await provider.index({ root: APP }))
})
afterAll(async () => {
	await provider.dispose()
	cache.dispose()
})

describe('the library, over a real tree', () => {
	it('indexes the fixture app: five source files, no skips beyond the choices', async () => {
		const r = ok(await provider.index({ root: APP }))
		expect(r.value.files).toMatchObject({ indexed: 5, parsed: 0, unchanged: 5, withParseErrors: 0 })
		expect(r.value.persisted).toBe(true)
		expect(r.evidence.coverage.status).toBe('complete')
	})

	it('find_literal: a thrown message, with the route handler that throws it', async () => {
		const r = ok(await provider.findLiteral({ root: APP, text: 'Invalid token' })).value
		// server.js throws it, auth.ts mentions it in a comparison.
		expect(r.total).toBe(2)
		const thrown = r.items.find((i) => i.path === at('server.js'))
		expect(thrown).toMatchObject({
			line: 9,
			kind: 'string',
			function: { kind: 'arrow', name: '/login' },
		})
		expect(thrown?.value).toBe('Invalid token: refusing login')
		const compared = r.items.find((i) => i.path === at('lib/auth.ts'))
		expect(compared?.function?.name).toBe('check')
	})

	it('find_literal: an anonymous function in a minified bundle is found by its literal', async () => {
		const r = ok(await provider.findLiteral({ root: APP, text: 'minified-needle' })).value
		expect(r.total).toBe(1)
		expect(r.items[0]?.line).toBe(1)
		expect(r.items[0]?.function?.name).toBe('t')
		expect(r.items[0]?.function?.kind).toBe('declaration')
	})

	it('enclosing_function: the exact source, its range, and its parent chain', async () => {
		const bundle = at('vendor/bundle.min.js')
		const hit = ok(await provider.findLiteral({ root: APP, text: 'minified-needle', path: bundle }))
			.value.items[0]
		const r = ok(
			await provider.enclosingFunction({
				root: APP,
				path: bundle,
				line: 1,
				column: hit?.column ?? 1,
			}),
		).value
		expect(r.function?.name).toBe('t')
		expect(r.source?.text).toBe('function t(n){return"minified-needle "+n}')
		// t sits inside the IIFE that wraps the whole module.
		expect(r.parents).toHaveLength(1)
		expect(r.parents[0]?.kind).toBe('expression')
		expect(r.parents[0]?.name).toBeNull()
	})

	it('function_source: a method by name, with the modifiers in its range', async () => {
		const r = ok(
			await provider.functionSource({ root: APP, path: at('lib/auth.ts'), name: 'create' }),
		).value
		expect(r.items).toHaveLength(1)
		expect(r.items[0]?.function.kind).toBe('method')
		expect(r.items[0]?.source.text).toBe(
			'static async create(secret: string): Promise<Authority> {\n\t\treturn new Authority(secret)\n\t}',
		)
	})

	it('callers_of: per file by default, wider on request', async () => {
		const here = ok(
			await provider.callersOf({ root: APP, name: 'verify', path: at('server.js') }),
		).value
		expect(here.total).toBe(1)
		expect(here.items[0]?.caller?.name).toBe('/login')
		const everywhere = ok(
			await provider.callersOf({ root: APP, name: 'verify', scope: 'workspace' }),
		)
		expect(everywhere.value.total).toBe(1)
		const members = ok(
			await provider.callersOf({ root: APP, name: 'split', scope: 'workspace', match: 'member' }),
		)
		expect(members.value.total).toBe(2)
	})

	it('imports: requires, type imports, dynamic imports and re-exports of the fixture', async () => {
		const server = ok(await provider.imports({ root: APP, path: at('server.js') })).value.items
		expect(
			server
				.filter((e) => e.direction === 'import')
				.map((e) => e.direction === 'import' && e.source),
		).toEqual(['node:http', './lib/auth.js'])
		const util = ok(await provider.imports({ root: APP, path: at('lib/util.mjs') })).value.items
		expect(
			util.map((e) => `${e.direction}:${e.kind}:${e.direction === 'export' ? e.name : e.source}`),
		).toEqual([
			'import:dynamic:./lazy.mjs',
			'export:star:*',
			'export:reexport:padStart',
			'export:reexport:other',
			'export:named:pad',
			'export:named:lazy',
		])
		const auth = ok(await provider.imports({ root: APP, path: at('lib/auth.ts') })).value.items
		expect(
			auth.some((e) => e.direction === 'import' && e.kind === 'type' && e.source === './types.js'),
		).toBe(true)
		expect(auth.some((e) => e.direction === 'export' && e.kind === 'default')).toBe(true)
	})

	it('reads TSX and strings in JSX attributes', async () => {
		const r = ok(await provider.findLiteral({ root: APP, text: 'Click to count' })).value
		expect(r.items[0]?.path).toBe(at('ui/Button.tsx'))
		expect(r.items[0]?.function?.name).toBe('Button')
	})
})

describe('through the SDK tool, with the real provider', () => {
	const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
		({ workingDirectory: APP, codeAnalysis: provider, ...over }) as ToolContext

	it('is registered by the SDK helper once a provider exists', () => {
		expect(getCodeAnalysisTools(provider)).toEqual([CodeAnalysisTool])
	})

	it('answers find_literal with citations, the function, and the evidence block', async () => {
		const r = await CodeAnalysisTool.execute(
			{ operation: 'find_literal', text: 'Invalid token' },
			ctx(),
		)
		expect(r.success).toBe(true)
		// Relative to the root, once per file; the line and column follow.
		expect(r.output).toMatch(/^server\.js\n {2}9:\d+ {2}"Invalid token/m)
		expect(r.output).toContain('/login#')
		expect(r.output).toContain('-- 2 of 2 shown. last page.')
		expect(r.output).toContain('observed:')
		expect(r.output).toContain('inferred:')
		expect(r.output).toContain('coverage: complete')
	})

	it('chains a literal to its function source through the id the first result printed', async () => {
		const first = await CodeAnalysisTool.execute(
			{ operation: 'find_literal', text: 'refusing login' },
			ctx(),
		)
		const id = Number(/#(\d+) L\d/.exec(first.output)?.[1])
		expect(Number.isInteger(id)).toBe(true)
		const second = await CodeAnalysisTool.execute(
			{ operation: 'function_source', function_id: id },
			ctx(),
		)
		expect(second.success).toBe(true)
		expect(second.output).toContain("throw new Error('Invalid token: refusing login')")
	})

	it('refuses a path outside the roots, and reaches it once the directory is added', async () => {
		const other = new Tree({ 'x.js': 'function x(){return "elsewhere"}' })
		try {
			const refused = await CodeAnalysisTool.execute(
				{ operation: 'imports', path: other.path('x.js') },
				ctx(),
			)
			expect(refused.success).toBe(false)
			expect(refused.error).toContain('Path escapes the working directory')

			const added = await CodeAnalysisTool.execute(
				{ operation: 'find_literal', text: 'elsewhere', path: other.root },
				ctx({ additionalDirectories: [other.root] }),
			)
			expect(added.success).toBe(true)
			expect(added.output).toMatch(/^x\.js\n {2}1:/m)
		} finally {
			other.dispose()
		}
	})
})
