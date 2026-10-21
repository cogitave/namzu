import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
	AnalysisEvidence,
	AnalysisFunction,
	CodeAnalysisProvider,
	CodeAnalysisResult,
} from '../../../types/code-analysis/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { CodeAnalysisTool, getCodeAnalysisTools } from '../code-analysis.js'
import { ReadFileTool } from '../read-file.js'

/**
 * The kernel half of code analysis: whether the tool exists at all, which
 * boundary a path goes through, and how the evidence reads on the page.
 *
 * Parsing and the store are `@namzu/analysis`'s to prove. What is here is what
 * a provider cannot defend itself against — a tool registered when there is
 * nothing to call, and a path pointing outside the workspace.
 */

const complete: AnalysisEvidence = {
	observed: ['read from the index'],
	inferred: [],
	coverage: { status: 'complete' },
}

const fn: AnalysisFunction = {
	id: 7,
	name: 'handler',
	kind: 'arrow',
	path: '/w/a.js',
	line: 3,
	column: 5,
	endLine: 9,
	start: 40,
	end: 120,
}

interface Seen {
	readonly op: string
	readonly request: Record<string, unknown>
}

function stub(over: Partial<CodeAnalysisProvider> = {}, seen: Seen[] = []): CodeAnalysisProvider {
	const ok = <T>(value: T): CodeAnalysisResult<T> => ({ kind: 'ok', value, evidence: complete })
	const record = (op: string) => (request: unknown) => {
		seen.push({ op, request: request as Record<string, unknown> })
	}
	return {
		index: async (r) => {
			record('index')(r)
			return ok({
				root: r.root,
				persisted: true,
				files: { indexed: 2, parsed: 2, unchanged: 0, removed: 0, skipped: 1, withParseErrors: 0 },
				skippedReasons: { binary: 1 },
				functions: 3,
				strings: 4,
				calls: 5,
				durationMs: 6,
			})
		},
		findLiteral: async (r) => {
			record('findLiteral')(r)
			return ok({ items: [], total: 0 })
		},
		enclosingFunction: async (r) => {
			record('enclosingFunction')(r)
			return ok({ function: fn, parents: [] })
		},
		functionSource: async (r) => {
			record('functionSource')(r)
			return ok({ items: [], total: 0 })
		},
		callersOf: async (r) => {
			record('callersOf')(r)
			return ok({ items: [], total: 0 })
		},
		imports: async (r) => {
			record('imports')(r)
			return ok({ items: [], total: 0 })
		},
		dispose: async () => {},
		...over,
	}
}

describe('registration', () => {
	it('is ABSENT when no provider is configured', () => {
		expect(getCodeAnalysisTools(undefined)).toEqual([])
	})

	it('is present when one is', () => {
		expect(getCodeAnalysisTools(stub())).toEqual([CodeAnalysisTool])
	})

	it('declares the same path argument as read, so the host reviews it the same way', () => {
		expect(CodeAnalysisTool.pathArgument).toBe('path')
		expect(CodeAnalysisTool.pathArgument).toBe(ReadFileTool.pathArgument)
	})
})

describe('path boundary', () => {
	let dir: string
	let outside: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-ca-'))
		outside = mkdtempSync(join(tmpdir(), 'namzu-ca-out-'))
		writeFileSync(join(dir, 'a.js'), 'export const x = 1\n')
		writeFileSync(join(outside, 'secret.js'), 'export const s = 1\n')
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
		rmSync(outside, { recursive: true, force: true })
	})

	const ctx = (over: Partial<ToolContext>): ToolContext =>
		({ workingDirectory: dir, ...over }) as ToolContext

	it('refuses an outside path with the message read gives, before the provider is asked', async () => {
		const seen: Seen[] = []
		const outsidePath = join(outside, 'secret.js')
		const mine = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: outsidePath },
			ctx({ codeAnalysis: stub({}, seen) }),
		)
		const theirs = await ReadFileTool.execute({ path: outsidePath }, ctx({}))

		expect(mine.success).toBe(false)
		expect(theirs.success).toBe(false)
		// One resolver, one wording: the boundary is the session's, not the tool's.
		expect(theirs.error).toContain(mine.error as string)
		expect(seen).toEqual([])
	})

	it('refuses a symlink that climbs out, as read does', async () => {
		symlinkSync(outside, join(dir, 'link'))
		const seen: Seen[] = []
		const mine = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: 'link/secret.js' },
			ctx({ codeAnalysis: stub({}, seen) }),
		)
		const theirs = await ReadFileTool.execute({ path: 'link/secret.js' }, ctx({}))
		expect(mine.success).toBe(false)
		expect(theirs.success).toBe(false)
		expect(seen).toEqual([])
	})

	it('accepts an outside path once the session has added the directory', async () => {
		const seen: Seen[] = []
		const result = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: join(outside, 'secret.js') },
			ctx({ codeAnalysis: stub({}, seen), additionalDirectories: [outside] }),
		)
		expect(result.success).toBe(true)
		expect(seen).toHaveLength(1)
		expect((seen[0]?.request.root as string).endsWith(outside.split('/').pop() as string)).toBe(
			true,
		)
	})

	it('does not widen a single approved file into its directory', async () => {
		const seen: Seen[] = []
		const file = join(outside, 'secret.js')
		const result = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: file },
			ctx({ codeAnalysis: stub({}, seen), approvedPaths: [file] }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('single file')
		expect(seen).toEqual([])
	})

	it('hands the provider the root and an absolute path inside it', async () => {
		const seen: Seen[] = []
		await CodeAnalysisTool.execute(
			{ operation: 'enclosing_function', path: 'a.js', line: 3, column: 9 },
			ctx({ codeAnalysis: stub({}, seen) }),
		)
		const req = seen[0]?.request as { root: string; path: string; line: number; column: number }
		expect(req.path.startsWith(req.root)).toBe(true)
		expect(req.path.endsWith('a.js')).toBe(true)
		expect(req).toMatchObject({ line: 3, column: 9 })
	})

	it('refuses in a sandboxed turn, where the host file system is not the workspace', async () => {
		const result = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: 'a.js' },
			ctx({ codeAnalysis: stub(), sandbox: {} as ToolContext['sandbox'] }),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('sandbox')
	})
})

describe('answers', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-ca-'))
		mkdirSync(join(dir, 'src'))
		writeFileSync(join(dir, 'src', 'a.js'), 'x\n')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))
	const ctx = (p: CodeAnalysisProvider): ToolContext =>
		({ workingDirectory: dir, codeAnalysis: p }) as ToolContext

	it('prints a page with its total, its cursor, and the evidence', async () => {
		const provider = stub({
			findLiteral: async () => ({
				kind: 'ok',
				value: {
					items: [
						{
							path: '/w/a.js',
							line: 3,
							column: 17,
							start: 50,
							end: 60,
							kind: 'string',
							value: 'hello',
							valueTruncated: false,
							function: fn,
						},
					],
					total: 120,
					nextCursor: 'abc',
				},
				evidence: {
					observed: ['1 literal contains "hello"'],
					inferred: ['the enclosing function is the innermost one by range'],
					coverage: { status: 'partial', reasons: ['1 file failed to parse'] },
				},
			}),
		})
		const result = await CodeAnalysisTool.execute(
			{ operation: 'find_literal', text: 'hello' },
			ctx(provider),
		)

		expect(result.success).toBe(true)
		// A path outside the root is printed whole, once, as the heading of its hits.
		expect(result.output).toContain('/w/a.js\n  3:17  "hello" in handler#7 L3-9')
		expect(result.output).toContain('1 of 120 shown. next cursor: abc')
		expect(result.output).toContain('observed: 1 literal contains "hello"')
		expect(result.output).toContain('inferred: the enclosing function')
		expect(result.output).toContain('coverage: partial - 1 file failed to parse')
		expect(result.data).toMatchObject({ value: { total: 120, nextCursor: 'abc' } })
	})

	it('says "No results" for an empty page, which is an answer', async () => {
		const result = await CodeAnalysisTool.execute(
			{ operation: 'callers_of', name: 'f', path: 'src/a.js' },
			ctx(stub()),
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('No results.')
		expect(result.output).toContain('coverage: complete')
	})

	it('reports a cut source slice as cut', async () => {
		const provider = stub({
			enclosingFunction: async () => ({
				kind: 'ok',
				value: {
					function: fn,
					parents: [],
					source: { text: 'function(){', chars: 90_000, truncated: true },
				},
				evidence: complete,
			}),
		})
		const result = await CodeAnalysisTool.execute(
			{ operation: 'enclosing_function', path: 'src/a.js', line: 1 },
			ctx(provider),
		)
		expect(result.output).toContain('cut: showing 11 of 90000 characters')
	})

	it('prints paths relative to the root, once per file, and names methods by their qualified name', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-ca-render-'))
		try {
			const a = join(dir, 'src', 'a.js')
			const b = join(dir, 'src', 'b.js')
			const method: AnalysisFunction = { ...fn, name: 'init', qualifiedName: 'Svc.init', path: a }
			const hit = (path: string, line: number) => ({
				path,
				line,
				column: 5,
				start: 0,
				end: 1,
				kind: 'string' as const,
				value: 'x',
				valueTruncated: false,
				function: method,
			})
			const provider = stub({
				findLiteral: async () => ({
					kind: 'ok',
					value: { items: [hit(a, 3), hit(a, 8), hit(b, 2)], total: 3 },
					evidence: complete,
				}),
			})
			const result = await CodeAnalysisTool.execute(
				{ operation: 'find_literal', text: 'x', path: dir },
				{ workingDirectory: dir, codeAnalysis: provider } as ToolContext,
			)
			const lines = result.output.split('\n')
			expect(lines.slice(0, 5)).toEqual([
				'src/a.js',
				'  3:5  "x" in Svc.init#7 L3-9',
				'  8:5  "x" in Svc.init#7 L3-9',
				'src/b.js',
				'  2:5  "x" in Svc.init#7 L3-9',
			])
			expect(result.output).not.toContain(dir)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('labels text-only and call-via callers, and a position in a class body', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-ca-render-'))
		try {
			const path = join(dir, 'a.js')
			const site = (over: Record<string, unknown>) => ({
				path,
				line: 4,
				column: 1,
				callee: 'x.init',
				kind: 'call' as const,
				argumentCount: 2,
				...over,
			})
			const provider = stub({
				callersOf: async () => ({
					kind: 'ok',
					value: {
						items: [
							site({ callee: 'this.init', resolution: 'resolved' }),
							site({ resolution: 'text-only' }),
							site({ callee: 'f', kind: 'call-via' }),
						],
						total: 3,
					},
					evidence: complete,
				}),
				enclosingFunction: async () => ({
					kind: 'ok',
					value: { function: null, parents: [], inClass: 'Svc' },
					evidence: complete,
				}),
			})
			const ctx = { workingDirectory: dir, codeAnalysis: provider } as ToolContext
			const callers = await CodeAnalysisTool.execute(
				{ operation: 'callers_of', name: 'Svc.init', scope: 'workspace', path: dir },
				ctx,
			)
			expect(callers.output).toContain('  4:1  this.init(2 args) at top level')
			expect(callers.output).toContain('  4:1  x.init(2 args) [text-only] at top level')
			expect(callers.output).toContain('  4:1  f(2 args) [call/apply/bind] at top level')
			const enclosing = await CodeAnalysisTool.execute(
				{ operation: 'enclosing_function', path: path, line: 7 },
				ctx,
			)
			expect(enclosing.output).toContain(
				'a.js:7:1 is in the body of class Svc, outside every method',
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it('passes a position to function_source, and says a windowed slice was cut around it', async () => {
		const seen: Seen[] = []
		const provider = stub(
			{
				functionSource: async (r) => {
					seen.push({ op: 'functionSource', request: r as unknown as Record<string, unknown> })
					return {
						kind: 'ok',
						value: {
							items: [
								{
									function: fn,
									parents: [],
									source: {
										text: 'head …tail',
										chars: 90_000,
										truncated: true,
										window: { headerChars: 4, from: 50_000, to: 51_000 },
									},
								},
							],
							total: 1,
						},
						evidence: complete,
					}
				},
			},
			seen,
		)
		const result = await CodeAnalysisTool.execute(
			{ operation: 'function_source', function_id: 7, line: 40, column: 3 },
			ctx(provider),
		)
		expect(seen[0]?.request.around).toEqual({ line: 40, column: 3 })
		expect(result.output).toContain("the function's first 4 and the part around the position")
	})

	it('turns a FAILURE into an error naming it unknown, never an empty result', async () => {
		const result = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: 'src/a.js' },
			ctx(stub({ imports: async () => ({ kind: 'failed', error: 'the store is locked' }) })),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('unknown rather than empty')
		expect(result.error).toContain('the store is locked')
	})

	it('turns UNSUPPORTED into a pointer at grep', async () => {
		const result = await CodeAnalysisTool.execute(
			{ operation: 'imports', path: 'src/a.js' },
			ctx(stub({ imports: async () => ({ kind: 'unsupported', reason: 'No SQLite here.' }) })),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('grep')
	})

	it('refuses callers_of with no file unless the wider scope is asked for by name', async () => {
		const seen: Seen[] = []
		const narrow = await CodeAnalysisTool.execute(
			{ operation: 'callers_of', name: 'f' },
			ctx(stub({}, seen)),
		)
		expect(narrow.success).toBe(false)
		expect(narrow.error).toContain('scope')
		expect(seen).toEqual([])

		const wide = await CodeAnalysisTool.execute(
			{ operation: 'callers_of', name: 'f', scope: 'workspace' },
			ctx(stub({}, seen)),
		)
		expect(wide.success).toBe(true)
		expect(seen[0]?.request).toMatchObject({ scope: 'workspace', name: 'f' })
	})

	it('needs an id, or a path and a name, for function_source', async () => {
		const result = await CodeAnalysisTool.execute({ operation: 'function_source' }, ctx(stub()))
		expect(result.success).toBe(false)
	})

	it('passes paging through with the default limit', async () => {
		const seen: Seen[] = []
		await CodeAnalysisTool.execute(
			{ operation: 'find_literal', text: 'q', cursor: 'c1' },
			ctx(stub({}, seen)),
		)
		expect(seen[0]?.request).toMatchObject({ limit: 50, cursor: 'c1', text: 'q' })
	})

	it('refuses with no provider on the context', async () => {
		const result = await CodeAnalysisTool.execute({ operation: 'imports', path: 'src/a.js' }, {
			workingDirectory: dir,
		} as ToolContext)
		expect(result.error).toContain('no code analysis provider')
	})
})

describe('cancelling, scoping and stale marks', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-ca-'))
		mkdirSync(join(dir, 'src'))
		writeFileSync(join(dir, 'src', 'a.js'), 'x\n')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('hands the turn abort signal to the provider on every operation', async () => {
		const seen: Seen[] = []
		const controller = new AbortController()
		const context = {
			workingDirectory: dir,
			codeAnalysis: stub({}, seen),
			abortSignal: controller.signal,
		} as ToolContext
		for (const input of [
			{ operation: 'index' },
			{ operation: 'find_literal', text: 'q' },
			{ operation: 'enclosing_function', path: 'src/a.js', line: 1 },
			{ operation: 'function_source', function_id: 3 },
			{ operation: 'callers_of', name: 'f', path: 'src/a.js' },
			{ operation: 'imports', path: 'src/a.js' },
		] as const) {
			await CodeAnalysisTool.execute(input, context)
		}
		expect(seen).toHaveLength(6)
		for (const call of seen) expect(call.request.signal).toBe(controller.signal)
	})

	it('indexes a narrower path as its own scope under the same root', async () => {
		const seen: Seen[] = []
		const context = { workingDirectory: dir, codeAnalysis: stub({}, seen) } as ToolContext
		await CodeAnalysisTool.execute({ operation: 'index' }, context)
		await CodeAnalysisTool.execute({ operation: 'index', path: 'src' }, context)
		expect(seen[0]?.request.scope).toBeUndefined()
		expect(String(seen[1]?.request.scope).endsWith('/src')).toBe(true)
		expect(seen[1]?.request.root).toBe(seen[0]?.request.root)
	})

	it('says when an index stopped early and how to go on', async () => {
		const provider = stub({
			index: async (r) => ({
				kind: 'ok',
				value: {
					root: r.root,
					persisted: true,
					files: {
						indexed: 5,
						parsed: 5,
						unchanged: 0,
						removed: 0,
						skipped: 0,
						withParseErrors: 0,
					},
					skippedReasons: {},
					functions: 1,
					strings: 1,
					calls: 1,
					durationMs: 9,
					truncated:
						'Indexing the root stopped after 45 seconds. Index a narrower path to cover the rest.',
				},
				evidence: complete,
			}),
		})
		const result = await CodeAnalysisTool.execute({ operation: 'index' }, {
			workingDirectory: dir,
			codeAnalysis: provider,
		} as ToolContext)
		expect(result.success).toBe(true)
		expect(result.output).toContain('Index a narrower path')
	})

	it('marks a hit whose file changed or was deleted', async () => {
		const hit = (stale: 'changed' | 'deleted') => ({
			path: '/w/a.js',
			line: 1,
			column: 1,
			start: 0,
			end: 3,
			kind: 'string' as const,
			value: 'v',
			valueTruncated: false,
			stale,
		})
		const provider = stub({
			findLiteral: async () => ({
				kind: 'ok',
				value: { items: [hit('changed'), hit('deleted')], total: 2 },
				evidence: complete,
			}),
		})
		const result = await CodeAnalysisTool.execute({ operation: 'find_literal', text: 'v' }, {
			workingDirectory: dir,
			codeAnalysis: provider,
		} as ToolContext)
		expect(result.output).toContain('[file changed since indexed; position may be off]')
		expect(result.output).toContain('[file deleted since indexed]')
	})
})

describe('the input schema', () => {
	const parse = (input: unknown) => CodeAnalysisTool.inputSchema.safeParse(input)

	it('rejects unknown operations and out-of-range paging', () => {
		expect(parse({ operation: 'nope' }).success).toBe(false)
		expect(parse({ operation: 'find_literal', text: 'x', limit: 5000 }).success).toBe(false)
		expect(parse({ operation: 'find_literal', text: '' }).success).toBe(false)
		expect(parse({ operation: 'enclosing_function', path: 'a.js', line: 0 }).success).toBe(false)
	})

	it('accepts each operation in its minimal form', () => {
		expect(parse({ operation: 'index' }).success).toBe(true)
		expect(parse({ operation: 'find_literal', text: 'x' }).success).toBe(true)
		expect(parse({ operation: 'enclosing_function', path: 'a.js', line: 1 }).success).toBe(true)
		expect(parse({ operation: 'function_source', function_id: 1 }).success).toBe(true)
		expect(parse({ operation: 'callers_of', name: 'f', path: 'a.js' }).success).toBe(true)
		expect(parse({ operation: 'imports', path: 'a.js' }).success).toBe(true)
	})
})
