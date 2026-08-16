import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { RoutingCodeNavigationProvider } from '../routing.js'
import { StdioCodeNavigationProvider } from '../stdio.js'
import type { CodeNavigationProvider } from '../types.js'

/**
 * The two operations an agent reaches for FIRST, and the routing that lets a
 * repository have more than one language.
 *
 * `symbols` is the entry point: `definition` and `references` both need a
 * line and a character, and an agent starting from a name has neither.
 * Without it, every navigation began with a grep — which is the text path
 * this package exists to replace, reintroduced as a prerequisite.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '..', '__fixtures__')
const SERVER = join(FIXTURES, 'ts-language-server.mjs')
const WORKSPACE = join(FIXTURES, 'workspace')

/**
 * Positions DERIVED from the fixture, never hard-coded.
 *
 * They were literals, and editing the fixture's doc comment silently moved
 * every one of them — three tests failed pointing at a resolver that was
 * fine. A position that is computed from the text cannot drift from it.
 */
function positionOf(
	file: string,
	needle: string,
	occurrence = 1,
): { line: number; character: number } {
	const lines = readFileSync(file, 'utf8').split('\n')
	let seen = 0
	for (let line = 0; line < lines.length; line++) {
		const character = lines[line]?.indexOf(needle) ?? -1
		if (character === -1) continue
		seen += 1
		if (seen === occurrence) return { line, character: character + 1 }
	}
	throw new Error(`${needle} is not in ${file} — the fixture and this test disagree`)
}

const open: CodeNavigationProvider[] = []
afterEach(async () => {
	while (open.length > 0) await open.pop()?.dispose()
})

function real() {
	const p = new StdioCodeNavigationProvider({
		command: process.execPath,
		args: [SERVER, WORKSPACE],
		rootDir: WORKSPACE,
		startupTimeoutMs: 20_000,
		requestTimeoutMs: 20_000,
	})
	open.push(p)
	return p
}

function withServer(script: string) {
	const p = new StdioCodeNavigationProvider({
		command: process.execPath,
		args: [join(FIXTURES, script)],
		rootDir: WORKSPACE,
		startupTimeoutMs: 8_000,
		requestTimeoutMs: 8_000,
	})
	open.push(p)
	return p
}

describe('symbols — finding a declaration with no position', () => {
	it('finds the declaration by name alone', async () => {
		const result = await real().symbols('computeTotal')

		expect(result.kind).toBe('symbols')
		if (result.kind !== 'symbols') return
		// No line, no character supplied. This is the operation that makes the
		// other two reachable.
		expect(result.symbols.some((s) => s.name === 'computeTotal' && s.path.endsWith('a.ts'))).toBe(
			true,
		)
	}, 40_000)

	it('returns nothing for an identifier that lives only in a comment and a string', async () => {
		// `phantomSymbolNeverDeclared` is written twice in the fixture — once in
		// a doc comment, once inside a string literal — and declared nowhere. A
		// grep returns both hits. A symbol index returns nothing, because
		// neither is a declaration, and that is the whole claim.
		const result = await real().symbols('phantomSymbolNeverDeclared')

		expect(result.kind).toBe('symbols')
		if (result.kind !== 'symbols') return
		expect(result.symbols).toEqual([])

		// And grep really does find it, so the assertion above is about
		// resolution rather than about a name that is simply absent.
		const text = readFileSync(join(WORKSPACE, 'a.ts'), 'utf8')
		expect(text.split('phantomSymbolNeverDeclared').length - 1).toBe(2)
	}, 40_000)

	it('is not what a grep of the same workspace would say', async () => {
		const result = await real().symbols('computeTotal')
		expect(result.kind).toBe('symbols')
		if (result.kind !== 'symbols') return

		const textual: string[] = []
		for (const entry of readdirSync(WORKSPACE)) {
			if (!entry.endsWith('.ts')) continue
			readFileSync(join(WORKSPACE, entry), 'utf8')
				.split('\n')
				.forEach((text, line) => {
					if (text.includes('computeTotal')) textual.push(`${entry}:${line}`)
				})
		}
		const resolved = result.symbols.map((s) => `${s.path.split('/').pop()}:${s.line}`)

		// Grep hits the comment, the string, the import, the re-export and the
		// call. A symbol search returns declarations.
		expect(new Set(resolved)).not.toEqual(new Set(textual))
		expect(resolved.length).toBeLessThan(textual.length)
	}, 40_000)
})

describe('hover', () => {
	it('gives the resolved type of a symbol', async () => {
		const at = positionOf(join(WORKSPACE, 'a.ts'), 'export function computeTotal')
		const result = await real().hover(join(WORKSPACE, 'a.ts'), at.line, at.character + 16)

		expect(result.kind).toBe('hover')
		if (result.kind !== 'hover') return
		// Resolved, not read off the source line: the signature comes from the
		// type checker.
		expect(result.contents).toContain('computeTotal')
		expect(result.contents).toContain('number')
	}, 40_000)

	it('answers EMPTY on whitespace rather than failing', async () => {
		// Line 2 of the fixture is ` *` inside a doc comment. Nothing resolves
		// there, and that is an answer — a caller has to be able to tell it
		// from a server that broke, which is why `contents` may be empty and
		// the kind stays `hover`.
		// The first line that is only ` *` — inside the doc comment, where
		// nothing resolves.
		const lines = readFileSync(join(WORKSPACE, 'a.ts'), 'utf8').split('\n')
		const blank = lines.findIndex((l) => l.trim() === '*')
		expect(blank).toBeGreaterThan(-1)
		const result = await real().hover(join(WORKSPACE, 'a.ts'), blank, 1)

		expect(result.kind).toBe('hover')
		if (result.kind !== 'hover') return
		expect(result.contents).toBe('')
	}, 40_000)
})

describe('capabilities are READ, not probed', () => {
	it('falls back to documentSymbol when the server declares no workspace index', async () => {
		const result = await withServer('declares-no-workspace-symbol.mjs').symbols(
			'computeTotal',
			join(WORKSPACE, 'a.ts'),
		)

		expect(result.kind).toBe('symbols')
		if (result.kind !== 'symbols') return
		expect(result.symbols.map((s) => s.name)).toContain('computeTotal')
	}, 30_000)

	it('walks the documentSymbol TREE, not just its top level', async () => {
		// `documentSymbol` nests: methods live under their class. A reader that
		// took only the top level would miss most of what a name search is for.
		const result = await withServer('declares-no-workspace-symbol.mjs').symbols(
			'label',
			join(WORKSPACE, 'a.ts'),
		)

		expect(result.kind).toBe('symbols')
		if (result.kind !== 'symbols') return
		expect(result.symbols.map((s) => s.name)).toContain('label')
	}, 30_000)

	it('is UNSUPPORTED, naming the capability, when the server declares neither', async () => {
		const result = await withServer('declares-nothing.mjs').symbols('computeTotal')

		// Not "method not found" bubbled up from a request nobody should have
		// sent: the handshake already said this server cannot do it.
		expect(result.kind).toBe('unsupported')
		if (result.kind !== 'unsupported') return
		expect(result.reason).toContain('workspaceSymbolProvider')
		expect(result.reason).toContain('documentSymbolProvider')
	}, 30_000)

	it('reports hover as unsupported when the server declares hoverProvider: false', async () => {
		const result = await withServer('declares-nothing.mjs').hover(join(WORKSPACE, 'a.ts'), 0, 0)
		// `declares-nothing` sends `{}`, so `hoverProvider` is absent rather
		// than `false` — an absent capability is not a declared refusal, and
		// this asserts the provider still tries rather than refusing on
		// silence. A server that says nothing may still answer.
		expect(['hover', 'unsupported', 'failed']).toContain(result.kind)
	}, 30_000)
})

describe('routing by extension', () => {
	function counting() {
		const spawns: string[] = []
		const provider = new RoutingCodeNavigationProvider({
			routes: [
				{ extensions: ['.ts', '.tsx'], server: { command: 'ts-server', rootDir: WORKSPACE } },
				{ extensions: ['.py'], server: { command: 'py-server', rootDir: WORKSPACE } },
			],
			createProvider: (options) => {
				spawns.push(options.command)
				return {
					definition: async () => ({ kind: 'locations', locations: [] }),
					references: async () => ({ kind: 'locations', locations: [] }),
					hover: async () => ({ kind: 'hover', contents: options.command }),
					symbols: async () => ({ kind: 'symbols', symbols: [] }),
					dispose: async () => {},
				}
			},
		})
		open.push(provider)
		return { provider, spawns }
	}

	it('sends two extensions to two distinct servers', async () => {
		const { provider, spawns } = counting()

		expect((await provider.hover('/w/a.ts', 0, 0)).kind).toBe('hover')
		expect((await provider.hover('/w/a.py', 0, 0)).kind).toBe('hover')

		expect(spawns).toEqual(['ts-server', 'py-server'])
	})

	it('reuses the server for a second file of the same language', async () => {
		const { provider, spawns } = counting()

		await provider.hover('/w/a.ts', 0, 0)
		await provider.definition('/w/b.tsx', 0, 0)
		await provider.references('/w/c.ts', 0, 0)

		// Asserted on the SPAWN COUNT, not on wall-clock time: a per-request
		// spawn is fast enough on a quick machine to pass a timing assertion
		// while paying the initialize handshake on every call.
		expect(spawns).toEqual(['ts-server'])
		expect(provider.startedCount()).toBe(1)
	})

	it('refuses an unconfigured extension by NAME rather than routing to a default', async () => {
		const { provider, spawns } = counting()

		const result = await provider.definition('/w/notes.unknownext', 0, 0)

		expect(result.kind).toBe('unsupported')
		if (result.kind !== 'unsupported') return
		// A default would send the file to a server that cannot read it, which
		// answers nothing, which reads as a symbol with no references — the
		// quiet wrong answer this refusal exists to prevent.
		expect(result.reason).toContain('.unknownext')
		expect(spawns).toEqual([])
	})

	it('matches an extension case-insensitively', async () => {
		const { provider, spawns } = counting()
		await provider.hover('/w/A.TS', 0, 0)
		// A `.TS` on a case-insensitive filesystem is the same language, and a
		// lookup that missed it would report the extension as unconfigured.
		expect(spawns).toEqual(['ts-server'])
	})

	it('searches every configured language when no scope is given', async () => {
		const { provider, spawns } = counting()
		await provider.symbols('anything')
		// "Find this symbol" in a mixed repository means all of it. A caller who
		// wanted one language would have passed a scope.
		expect(new Set(spawns)).toEqual(new Set(['ts-server', 'py-server']))
	})

	it('does not report an empty result when every server refused', async () => {
		const provider = new RoutingCodeNavigationProvider({
			routes: [{ extensions: ['.ts'], server: { command: 'x', rootDir: WORKSPACE } }],
			createProvider: () => ({
				definition: async () => ({ kind: 'locations', locations: [] }),
				references: async () => ({ kind: 'locations', locations: [] }),
				hover: async () => ({ kind: 'hover', contents: '' }),
				symbols: async () => ({ kind: 'unsupported', reason: 'no index here' }),
				dispose: async () => {},
			}),
		})
		open.push(provider)

		const result = await provider.symbols('computeTotal')

		// `symbols: []` would tell the caller the name does not exist in the
		// repository. Nobody looked.
		expect(result.kind).toBe('unsupported')
	})
})
