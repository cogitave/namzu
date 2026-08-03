import { describe, expect, it, vi } from 'vitest'

import type { Sandbox } from '../../types/sandbox/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { GlobTool } from '../builtins/glob.js'
import { GrepTool } from '../builtins/grep.js'

/**
 * Both tools reached `node:fs` directly and referenced `context.sandbox`
 * nowhere, so with a container backend wired in the sandbox was not a read
 * boundary at all — every sibling builtin already remembered the branch.
 *
 * The paths they returned were host-relative too, while `read` resolves
 * what it is handed INSIDE the sandbox, so every search-to-read handoff
 * either failed or opened a different file. The two roots genuinely
 * diverge: the executor passes `workingDirectory` unchanged alongside the
 * sandbox and never re-points it at `sandbox.rootDir`.
 */

const SANDBOX_ROOT = '/sandbox/workspace'
const HOST_ROOT = '/host/elsewhere'

function fakeSandbox(files: Record<string, string>): Sandbox & { reads: string[] } {
	const reads: string[] = []
	return {
		id: 'sbx_test' as never,
		rootDir: SANDBOX_ROOT,
		reads,
		exec: vi.fn(),
		writeFile: vi.fn(),
		readFile: vi.fn(async (path: string) => {
			reads.push(path)
			const key = path.startsWith(SANDBOX_ROOT) ? path.slice(SANDBOX_ROOT.length + 1) : path
			const content = files[key.split('\\').join('/')]
			if (content === undefined) throw new Error(`no such file: ${path}`)
			return Buffer.from(content, 'utf-8')
		}),
		listFiles: vi.fn(async () =>
			Object.keys(files).map((path) => ({ path, size: files[path]?.length ?? 0 })),
		),
		destroy: vi.fn(),
		status: vi.fn(),
	} as unknown as Sandbox & { reads: string[] }
}

const context = (sandbox: Sandbox): ToolContext =>
	({
		// Deliberately different from the sandbox root: the executor passes
		// the host working directory through unchanged, so a tool that
		// reads this one is reading the wrong filesystem.
		workingDirectory: HOST_ROOT,
		sandbox,
		env: {},
		abortSignal: new AbortController().signal,
	}) as unknown as ToolContext

describe('glob inside a sandbox', () => {
	it('enumerates through the sandbox, not the host', async () => {
		const sandbox = fakeSandbox({ 'src/a.ts': 'a', 'src/b.js': 'b' })
		const result = await GlobTool.execute({ pattern: '**/*.ts' } as never, context(sandbox))

		expect(sandbox.listFiles).toHaveBeenCalled()
		expect(result.output).toContain('src/a.ts')
		expect(result.output).not.toContain('b.js')
	})

	it('returns paths the sandbox-side reader can actually open', async () => {
		const sandbox = fakeSandbox({ 'src/a.ts': 'a' })
		const result = await GlobTool.execute({ pattern: '**/*.ts' } as never, context(sandbox))

		// A host-relative path here is a string `read` resolves somewhere
		// else, so the handoff between the two tools has to agree on a
		// coordinate system.
		expect(result.output).not.toContain(HOST_ROOT)
		expect(result.output.trim()).toBe('./src/a.ts')
	})

	it('says it searched the sandbox', async () => {
		const sandbox = fakeSandbox({ 'a.ts': 'a' })
		const result = await GlobTool.execute({ pattern: '**/*.ts' } as never, context(sandbox))
		expect((result.data as { sandboxed?: boolean }).sandboxed).toBe(true)
	})

	it('refuses a path that climbs out of the sandbox root', async () => {
		const sandbox = fakeSandbox({ 'a.ts': 'a' })
		const result = await GlobTool.execute(
			{ pattern: '*.ts', path: '../../etc' } as never,
			context(sandbox),
		)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})
})

describe('grep inside a sandbox', () => {
	const args = (extra: object = {}) =>
		({
			pattern: 'needle',
			case_sensitive: true,
			context_lines: 0,
			max_results: 50,
			...extra,
		}) as never

	it('reads through the sandbox, not the host', async () => {
		const sandbox = fakeSandbox({ 'src/a.ts': 'a needle here\n' })
		const result = await GrepTool.execute(args(), context(sandbox))

		expect(sandbox.readFile).toHaveBeenCalled()
		// Asserted on the MATCH line, not on the word. The no-matches
		// message quotes the pattern back, so checking for "needle" alone
		// passed on a search that found nothing — which is exactly what this
		// test existed to catch.
		expect(result.output).toContain('a needle here')
		expect(result.output).toContain('Found 1 match')
	})

	it('reports paths relative to the sandbox root', async () => {
		const sandbox = fakeSandbox({ 'src/a.ts': 'a needle here\n' })
		const result = await GrepTool.execute(args(), context(sandbox))

		expect(result.output).toContain('./src/a.ts')
		expect(result.output).not.toContain(HOST_ROOT)
	})

	it('honours the include filter through the sandbox listing', async () => {
		const sandbox = fakeSandbox({ 'a.ts': 'needle\n', 'b.md': 'needle\n' })
		const result = await GrepTool.execute(args({ include: '*.ts' }), context(sandbox))

		expect(result.output).toContain('a.ts')
		expect(result.output).not.toContain('b.md')
	})

	it('refuses a path that climbs out of the sandbox root', async () => {
		const sandbox = fakeSandbox({ 'a.ts': 'needle\n' })
		const result = await GrepTool.execute(args({ path: '../../etc' }), context(sandbox))
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/escapes the working directory/)
	})
})
