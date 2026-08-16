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
			dispose: async () => {},
		},
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
