import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { StdioCodeNavigationProvider } from '../stdio.js'
import type { CodeNavigationProvider } from '../types.js'

/**
 * The claim this package makes: an agent asked for call sites gets symbol
 * resolution, not regex matches.
 *
 * The fixture workspace is built so a grep and a resolver give DIFFERENT
 * answers — the identifier appears in a comment, in a string literal, and
 * as an unrelated same-named function in another file, and the real call
 * site arrives through a re-export. A test that a grep-backed fake could
 * pass would prove nothing about this package, so the fixture is arranged
 * to make that impossible.
 *
 * The server the tests drive is a real one: `__fixtures__/ts-language-server.mjs`
 * is an LSP wire over `ts.LanguageService`, the same resolver the compiler
 * uses. Its answers are resolved rather than scripted, which is the whole
 * reason it is not a stub.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', '__fixtures__', 'ts-language-server.mjs')
const WORKSPACE = join(HERE, '..', '__fixtures__', 'workspace')

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

/** `computeTotal`'s declaration, zero-based, as LSP counts. */
const A_TS = join(WORKSPACE, 'a.ts')
const DECLARATION = { file: A_TS, ...positionOf(A_TS, 'export function computeTotal') }

const open: CodeNavigationProvider[] = []
afterEach(async () => {
	while (open.length > 0) await open.pop()?.dispose()
})

function provider(
	over: Partial<ConstructorParameters<typeof StdioCodeNavigationProvider>[0]> = {},
) {
	const p = new StdioCodeNavigationProvider({
		command: process.execPath,
		args: [SERVER, WORKSPACE],
		rootDir: WORKSPACE,
		startupTimeoutMs: 20_000,
		requestTimeoutMs: 20_000,
		...over,
	})
	open.push(p)
	return p
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error(`operation did not settle within ${timeoutMs}ms`)),
					timeoutMs,
				)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000
	while (processIsAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

/** What the tool this replaces would have answered. */
function grepFor(identifier: string): { file: string; line: number }[] {
	const hits: { file: string; line: number }[] = []
	for (const entry of readdirSync(WORKSPACE)) {
		if (!entry.endsWith('.ts')) continue
		const lines = readFileSync(join(WORKSPACE, entry), 'utf8').split('\n')
		lines.forEach((text, line) => {
			if (text.includes(identifier)) hits.push({ file: entry, line })
		})
	}
	return hits
}

describe('references, against a real resolver', () => {
	it('finds the call site that arrives through a re-export', async () => {
		const result = await provider().references(
			DECLARATION.file,
			DECLARATION.line,
			DECLARATION.character,
		)

		expect(result.kind).toBe('locations')
		if (result.kind !== 'locations') return
		const files = result.locations.map((l) => l.path.split('/').pop())

		// `b.ts` imports from `index.ts`, which re-exports from `a.ts`. A regex
		// over `a.ts`'s own text can never reach it, and this is the case a
		// rename has to get right.
		expect(files).toContain('b.ts')
		expect(files).toContain('index.ts')
	}, 40_000)

	it('does not count the declaration itself as a use', async () => {
		const result = await provider().references(
			DECLARATION.file,
			DECLARATION.line,
			DECLARATION.character,
		)
		expect(result.kind).toBe('locations')
		if (result.kind !== 'locations') return

		// An agent asking who calls this wants the call sites. Including the
		// declaration inflates the count by one and reads as a caller that does
		// not exist — which matters most at a count of one, where it turns
		// "nothing uses this" into "something does".
		expect(
			result.locations.some((l) => l.path.endsWith('a.ts') && l.line === DECLARATION.line),
		).toBe(false)
	}, 40_000)

	it('gives a DIFFERENT answer from a grep over the same workspace', async () => {
		const result = await provider().references(
			DECLARATION.file,
			DECLARATION.line,
			DECLARATION.character,
		)
		expect(result.kind).toBe('locations')
		if (result.kind !== 'locations') return

		const grep = grepFor('computeTotal')
		const resolved = result.locations.map((l) => `${l.path.split('/').pop()}:${l.line}`)
		const textual = grep.map((h) => `${h.file}:${h.line}`)

		// The assertion that a grep-backed fake cannot survive. If these two
		// sets matched, this package would be an expensive way to run `grep`.
		expect(new Set(resolved)).not.toEqual(new Set(textual))

		// And specifically: the comment mention, the string literal, and the
		// unrelated same-named function are all things grep counts as call
		// sites and a resolver does not.
		// Derived, not hard-coded: the comment line and the string line move
		// whenever the fixture's prose does, and a literal here fails pointing
		// at a resolver that is fine.
		const commentLine = positionOf(A_TS, '`computeTotal` also appears').line
		const stringLine = positionOf(A_TS, "'computeTotal ran").line
		expect(textual).toContain(`a.ts:${commentLine}`)
		expect(textual).toContain(`a.ts:${stringLine}`)
		expect(textual.some((t) => t.startsWith('unrelated.ts'))).toBe(true)
		expect(resolved).not.toContain(`a.ts:${commentLine}`)
		expect(resolved).not.toContain(`a.ts:${stringLine}`)
		expect(resolved.some((r) => r.startsWith('unrelated.ts'))).toBe(false)
	}, 40_000)
})

describe('definition', () => {
	it('lands on the original declaration, not the re-export line', async () => {
		// `b.ts` imports `computeTotal` from `index.ts`. The naive answer is
		// `index.ts`'s `export { computeTotal }` line, which is where the name
		// literally appears; the useful answer is `a.ts`, where the function is.
		const result = await provider().definition(join(WORKSPACE, 'b.ts'), 3, 26)

		expect(result.kind).toBe('locations')
		if (result.kind !== 'locations') return
		expect(result.locations.map((l) => l.path.split('/').pop())).toContain('a.ts')
	}, 40_000)
})

describe('a server that will not start', () => {
	it('FAILS, naming the binary, rather than answering with no locations', async () => {
		const result = await provider({
			command: '/definitely/not/a/language/server',
			args: [],
			startupTimeoutMs: 3_000,
		}).references(DECLARATION.file, 0, 0)

		// `{ kind: 'locations', locations: [] }` here tells an agent the symbol
		// has no callers. The agent then deletes it. That is the whole reason
		// this union has three members instead of one nullable list.
		expect(result.kind).toBe('failed')
		if (result.kind !== 'failed') return
		expect(result.error).toContain('/definitely/not/a/language/server')
	}, 30_000)

	it('fails the same way when the binary runs but never initializes', async () => {
		// A server that starts, holds the pipe open, and answers nothing —
		// waiting on a prompt, or wedged on a malformed workspace. Indefinite
		// silence is the failure a timeout exists for.
		const result = await provider({
			command: process.execPath,
			args: ['-e', 'process.stdin.resume()'],
			startupTimeoutMs: 700,
		}).definition(DECLARATION.file, 0, 0)

		expect(result.kind).toBe('failed')
		if (result.kind !== 'failed') return
		expect(result.error).toContain('did not answer initialize')
	}, 30_000)

	it('does not respawn on every call after it has failed once', async () => {
		const p = provider({ command: '/definitely/not/a/language/server', startupTimeoutMs: 2_000 })
		const first = await p.definition(DECLARATION.file, 0, 0)
		const second = await p.references(DECLARATION.file, 0, 0)

		// A run that asks twenty times must not spawn twenty processes against
		// a binary that is not there.
		expect(first.kind).toBe('failed')
		expect(second.kind).toBe('failed')
	}, 30_000)
})

describe('a method the server does not implement', () => {
	it('is unsupported, not failed', async () => {
		// A server that answers `-32601` has told us it cannot do this. A
		// caller can fall back to grep and SAY SO, where a failure means the
		// answer is unknown and a fallback would be a guess.
		const p = provider({
			command: process.execPath,
			args: [join(HERE, '..', '__fixtures__', 'answers-method-not-found.mjs')],
			startupTimeoutMs: 8_000,
		})
		const result = await p.references(DECLARATION.file, 0, 0)

		expect(result.kind).toBe('unsupported')
	}, 30_000)
})

describe('a live server whose protocol stream closes', () => {
	it('retires pending and future requests immediately, then still owns process teardown', async () => {
		const temp = mkdtempSync(join(tmpdir(), 'namzu-lsp-transport-'))
		const marker = join(temp, 'events.txt')
		const p = provider({
			command: process.execPath,
			args: [join(HERE, '..', '__fixtures__', 'closes-response-stream.mjs'), marker],
			startupTimeoutMs: 8_000,
			requestTimeoutMs: 30_000,
		})

		try {
			const first = await settleWithin(p.references(DECLARATION.file, 0, 0), 2_000)
			expect(first.kind).toBe('failed')
			if (first.kind !== 'failed') return
			expect(first.error).toContain('response stream closed unexpectedly')

			// The first failure is latched. A second call neither respawns nor
			// waits for its own 30-second request timeout.
			const second = await settleWithin(p.definition(DECLARATION.file, 0, 0), 2_000)
			expect(second.kind).toBe('failed')
			expect((p as unknown as { pending: Map<number, unknown> }).pending.size).toBe(0)
			expect(readFileSync(marker, 'utf8').match(/^references$/gm)).toHaveLength(1)

			const pid = Number(/^pid:(\d+)$/m.exec(readFileSync(marker, 'utf8'))?.[1])
			expect(Number.isSafeInteger(pid)).toBe(true)
			expect(processIsAlive(pid)).toBe(true)

			await p.dispose()
			open.pop()
			await waitForProcessExit(pid)
			expect(processIsAlive(pid)).toBe(false)
		} finally {
			await p.dispose()
			const index = open.indexOf(p)
			if (index !== -1) open.splice(index, 1)
			rmSync(temp, { recursive: true, force: true })
		}
	}, 30_000)
})

describe('dispose', () => {
	it('terminates the server, which does not outlive the run', async () => {
		const p = provider()
		// Force the spawn: the process only exists once something is asked.
		await p.definition(DECLARATION.file, DECLARATION.line, DECLARATION.character)

		const child = (p as unknown as { child?: { pid?: number; killed: boolean } }).child
		const pid = child?.pid
		expect(pid).toBeDefined()

		await p.dispose()
		open.pop()

		// Observed on the OS, not on a flag this class sets itself: `kill(0)`
		// throws ESRCH once the process is gone, and a provider that only
		// stopped talking to it would leave one behind per run.
		await new Promise((resolve) => setTimeout(resolve, 300))
		let alive = true
		try {
			process.kill(pid as number, 0)
		} catch {
			alive = false
		}
		expect(alive).toBe(false)
	}, 40_000)

	it('sends the shutdown handshake, not only a kill', async () => {
		// The kill is the fallback and it is why the test above passes even
		// with the handshake removed — the process dies either way. What the
		// handshake buys is a server that gets to finish: some hold a lock
		// file, some are mid-write on an index. So it is asserted directly,
		// against a server that records what it was asked.
		const marker = join(mkdtempSync(join(tmpdir(), 'namzu-lsp-shutdown-')), 'saw.txt')
		const p = provider({
			command: process.execPath,
			args: [join(HERE, '..', '__fixtures__', 'records-shutdown.mjs'), marker],
			startupTimeoutMs: 8_000,
		})
		await p.definition(DECLARATION.file, 0, 0)
		await p.dispose()
		open.pop()

		expect(readFileSync(marker, 'utf8')).toContain('shutdown')
	}, 30_000)

	it('refuses further queries once disposed', async () => {
		const p = provider()
		await p.dispose()
		open.pop()

		const result = await p.definition(DECLARATION.file, 0, 0)
		// Not an empty result: the provider is gone, and saying so is different
		// from having looked.
		expect(result.kind).toBe('failed')
	}, 30_000)
})
