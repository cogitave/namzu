import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
	CodeNavigationProvider,
	CodeNavigationResult,
} from '../../../types/code-navigation/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { LspTool, getCodeNavigationTools } from '../lsp.js'

/**
 * The kernel half of code navigation: whether the tool exists at all, and
 * whether a path reaches the server before anything checks it.
 *
 * The resolution itself is `@namzu/lsp`'s to prove, against a real server.
 * What is here is the two things a provider cannot defend itself against —
 * a tool registered when there is nothing to call, and a path pointing
 * outside the workspace.
 */

interface Recorded {
	readonly calls: { op: string; file: string; line: number; character: number }[]
	readonly provider: CodeNavigationProvider
}

function recording(answer: CodeNavigationResult): Recorded {
	const calls: Recorded['calls'] = []
	return {
		calls,
		provider: {
			definition: async (file, line, character) => {
				calls.push({ op: 'definition', file, line, character })
				return answer
			},
			references: async (file, line, character) => {
				calls.push({ op: 'references', file, line, character })
				return answer
			},
			hover: async (file, line, character) => {
				calls.push({ op: 'hover', file, line, character })
				return { kind: 'hover', contents: 'const x: number' }
			},
			symbols: async (query, scope) => {
				calls.push({ op: 'symbols', file: scope ?? '', line: -1, character: -1 })
				void query
				return { kind: 'symbols', symbols: [] }
			},
			dispose: async () => {},
		},
	}
}

/** A provider typed as one, so a context built from it is assignable. */
function providerWith(over: Partial<CodeNavigationProvider>): CodeNavigationProvider {
	return {
		definition: async () => ({ kind: 'locations', locations: [] }),
		references: async () => ({ kind: 'locations', locations: [] }),
		hover: async () => ({ kind: 'hover', contents: '' }),
		symbols: async () => ({ kind: 'symbols', symbols: [] }),
		dispose: async () => {},
		...over,
	}
}

describe('registration', () => {
	it('is ABSENT when no provider is configured', () => {
		// A tool that is always present and always answers "unavailable" costs
		// a decision on every turn to say nothing, and teaches a model that a
		// capability exists when it does not.
		expect(getCodeNavigationTools(undefined)).toEqual([])
	})

	it('is present when one is', () => {
		// The other direction, so the assertion above cannot be satisfied by a
		// function that returns nothing at all.
		expect(
			getCodeNavigationTools(recording({ kind: 'locations', locations: [] }).provider),
		).toEqual([LspTool])
	})
})

describe('path containment', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-lsp-'))
		writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	function context(over: Partial<ToolContext> = {}): ToolContext {
		return { workingDirectory: dir, ...over } as ToolContext
	}

	it('refuses a path escaping the working directory BEFORE the provider is asked', async () => {
		const stub = recording({ kind: 'locations', locations: [] })

		const result = await LspTool.execute(
			{ operation: 'references', path: '../../etc/passwd', line: 0, character: 0 },
			context({ codeNavigation: stub.provider }),
		)

		expect(result.success).toBe(false)
		// The point of "before": a language server indexes a workspace and will
		// answer about anything it is handed. Containment is this tool's job,
		// and a check after the call is not containment.
		expect(stub.calls).toEqual([])
	})

	it('passes an in-workspace path through, as an absolute one', async () => {
		const stub = recording({ kind: 'locations', locations: [] })

		await LspTool.execute(
			{ operation: 'definition', path: 'a.ts', line: 3, character: 7 },
			context({ codeNavigation: stub.provider }),
		)

		// Absolute: a server is given a URI, and a relative path would resolve
		// against whatever directory the server happens to be in.
		expect(stub.calls).toHaveLength(1)
		expect(stub.calls[0]?.file.startsWith('/')).toBe(true)
		expect(stub.calls[0]).toMatchObject({ op: 'definition', line: 3, character: 7 })
	})
})

describe('the three answers', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-lsp-'))
		writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	const run = async (answer: CodeNavigationResult) =>
		await LspTool.execute({ operation: 'references', path: 'a.ts', line: 0, character: 13 }, {
			workingDirectory: dir,
			codeNavigation: recording(answer).provider,
		} as ToolContext)

	it('reports locations as file:line:character', async () => {
		const result = await run({
			kind: 'locations',
			locations: [{ path: '/w/b.ts', line: 4, character: 2 }],
		})
		expect(result.success).toBe(true)
		expect(result.output).toContain('/w/b.ts:4:2')
	})

	it('says plainly that there are none, which a deletion depends on', async () => {
		const result = await run({ kind: 'locations', locations: [] })
		// A real answer. It must read differently from a failure, because
		// "nothing uses this" is what makes a deletion safe.
		expect(result.success).toBe(true)
		expect(result.output).toContain('No references found')
	})

	it('turns a FAILURE into an error naming it unknown, never an empty result', async () => {
		const result = await run({ kind: 'failed', error: 'the server never started' })

		// The whole reason this union has three members. An agent told a symbol
		// has no callers deletes it; an agent told the resolver broke does
		// something else.
		expect(result.success).toBe(false)
		expect(result.error).toContain('unknown rather than empty')
		expect(result.error).toContain('the server never started')
	})

	it('turns UNSUPPORTED into a pointer at grep, with the caveat attached', async () => {
		const result = await run({ kind: 'unsupported', reason: 'that server has no reference index.' })

		// Distinct from a failure: the caller can fall back and knows why the
		// fallback is approximate.
		expect(result.success).toBe(false)
		expect(result.error).toContain('grep')
		expect(result.error).toContain('textual rather than resolved')
	})

	it('refuses when the tool was registered with no provider at all', async () => {
		const result = await LspTool.execute(
			{ operation: 'references', path: 'a.ts', line: 0, character: 0 },
			{ workingDirectory: dir } as ToolContext,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('no code navigation provider')
	})
})

describe('the input schema', () => {
	/**
	 * Position is required where it means something and forbidden where it
	 * does not, which is the whole reason this is a discriminated union
	 * rather than four optional fields.
	 */
	const parse = (input: unknown) => LspTool.inputSchema.safeParse(input)

	it('REJECTS a definition with no position', () => {
		// Making position unconditionally optional kills this: a `definition`
		// call with no line silently resolves whatever sits at the top of the
		// file, and the model gets a confident answer about the wrong symbol.
		expect(parse({ operation: 'definition', path: 'a.ts' }).success).toBe(false)
		expect(parse({ operation: 'hover', path: 'a.ts', line: 1 }).success).toBe(false)
		expect(parse({ operation: 'references', path: 'a.ts', character: 1 }).success).toBe(false)
	})

	it('ACCEPTS a symbols query with no position', () => {
		// Making it unconditionally required kills this — and `symbols` exists
		// precisely because an agent starting from a name has no position.
		// Forcing one means inventing two numbers.
		expect(parse({ operation: 'symbols', query: 'computeTotal' }).success).toBe(true)
		expect(parse({ operation: 'symbols', query: 'computeTotal', path: 'a.ts' }).success).toBe(true)
	})

	it('accepts a positioned operation that has one', () => {
		expect(parse({ operation: 'definition', path: 'a.ts', line: 0, character: 0 }).success).toBe(
			true,
		)
	})

	it('rejects a symbols call with an empty query', () => {
		// An empty query matches everything on a fuzzy index, which is a
		// thousand results and no information.
		expect(parse({ operation: 'symbols', query: '' }).success).toBe(false)
	})
})

describe('hover and symbols through the tool', () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'namzu-lsp-'))
		writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n')
	})
	afterEach(() => rmSync(dir, { recursive: true, force: true }))

	it('reports an EMPTY hover as an answer, not a failure', async () => {
		const result = await LspTool.execute(
			{ operation: 'hover', path: 'a.ts', line: 0, character: 0 },
			{ workingDirectory: dir, codeNavigation: providerWith({}) } as ToolContext,
		)

		// Whitespace and comments resolve to nothing. That is a real answer and
		// it must read differently from a server that broke.
		expect(result.success).toBe(true)
		expect(result.output).toContain('Nothing to show')
	})

	it('searches by name with no path at all', async () => {
		const seen: (string | undefined)[] = []
		const result = await LspTool.execute({ operation: 'symbols', query: 'computeTotal' }, {
			workingDirectory: dir,
			codeNavigation: providerWith({
				symbols: async (_q, scope) => {
					seen.push(scope)
					return {
						kind: 'symbols',
						symbols: [{ path: '/w/a.ts', line: 4, character: 2, name: 'computeTotal' }],
					}
				},
			}),
		} as ToolContext)

		expect(result.success).toBe(true)
		expect(result.output).toContain('computeTotal — /w/a.ts:4:2')
		// No path given, so no scope invented. A path resolved from nothing
		// would silently narrow the search to one file.
		expect(seen).toEqual([undefined])
	})
})
