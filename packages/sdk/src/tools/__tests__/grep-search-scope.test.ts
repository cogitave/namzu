import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { walkFilesLocally } from '../../sandbox/file-walk.js'
import type {
	Sandbox,
	SandboxFileEntry,
	SandboxWalkFilesOptions,
} from '../../types/sandbox/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { GrepTool } from '../builtins/grep.js'

const ROOT = '/sandbox/project'
const args = (extra: object = {}) => ({
	pattern: 'needle',
	case_sensitive: true,
	context_lines: 0,
	max_results: 100,
	...extra,
})
const context = (sandbox: Sandbox, signal = new AbortController().signal) =>
	({ sandbox, workingDirectory: '/host/elsewhere', abortSignal: signal }) as ToolContext

const temporary: string[] = []
afterEach(() => {
	for (const path of temporary.splice(0)) removeTempDir(path)
})

function sandboxWith(walk: () => AsyncIterable<SandboxFileEntry>) {
	return {
		rootDir: ROOT,
		walkFiles: vi.fn(walk),
		listFiles: vi.fn(async () => {
			throw new Error('Eager listing must not run')
		}),
		readFile: vi.fn(async () => Buffer.from('needle\n')),
	} as unknown as Sandbox & {
		walkFiles: ReturnType<typeof vi.fn>
		listFiles: ReturnType<typeof vi.fn>
		readFile: ReturnType<typeof vi.fn>
	}
}

describe('grep bounds file discovery before reading', () => {
	it('searches a named file without opening its parent directory', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-grep-file-'))
		temporary.push(root)
		await writeFile(join(root, 'package.json'), '{"name":"needle"}\n')
		await writeFile(join(root, 'other.json'), 'needle must not be read')
		const result = await GrepTool.execute(args({ path: 'package.json' }), {
			workingDirectory: root,
		} as ToolContext)
		expect(result.success).toBe(true)
		expect(result.output).toContain('package.json:1:{"name":"needle"}')
		expect(result.output).not.toContain('other.json')
		const excluded = await GrepTool.execute(args({ path: 'package.json', include: '*.ts' }), {
			workingDirectory: root,
		} as ToolContext)
		expect(excluded.output).toContain('No matches')
	})
	it('stops incremental enumeration at the match cap and identifies the incomplete search', async () => {
		let closed = false
		const sandbox = sandboxWith(async function* () {
			try {
				yield { path: `${ROOT}/first.ts`, size: 7 }
				throw new Error('The match cap should close this iterator before another file')
			} finally {
				closed = true
			}
		})
		const ctx = context(sandbox)
		const result = await GrepTool.execute(args({ include: '*.ts', max_results: 1 }), ctx)
		expect(result.success).toBe(true)
		expect(result.output).toContain('./first.ts:1:needle')
		expect(result.output).toMatch(/incomplete|not exhaustive/i)
		expect(result.data).toMatchObject({ totalMatches: 1, truncated: true })
		expect(closed).toBe(true)
		expect(sandbox.listFiles).not.toHaveBeenCalled()
		expect(sandbox.walkFiles).toHaveBeenCalledWith(
			ROOT,
			expect.objectContaining({
				pattern: '**/*.ts',
				signal: ctx.abortSignal,
				maxVisitedEntries: 20_000,
			}),
		)
	})

	it('retains found lines when the traversal budget is exhausted', async () => {
		const sandbox = sandboxWith(async function* () {
			yield { path: `${ROOT}/first.ts`, size: 7 }
			throw Object.assign(new Error('File search stopped after examining 20000 entries'), {
				code: 'ERR_FILE_WALK_LIMIT',
			})
		})
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(false)
		expect(result.output).toContain('./first.ts:1:needle')
		expect(result.output).toContain('Search incomplete')
		expect(result.error).toContain('20000')
		expect(result.data).toMatchObject({ totalMatches: 1, truncated: true })
	})

	it('does not claim an exhausted search found no matches throughout its scope', async () => {
		const sandbox = sandboxWith(async function* () {
			yield { path: `${ROOT}/first.ts`, size: 7 }
			throw new Error('File search stopped after examining 20000 entries')
		})
		sandbox.readFile.mockResolvedValue(Buffer.from('unrelated'))
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(false)
		expect(result.output).toContain('No matches found in the files searched')
		expect(result.output).toContain('Search incomplete')
		expect(result.data).toMatchObject({ totalMatches: 0, truncated: true })
	})

	it('records a complete scan only when enumeration finishes before the match cap', async () => {
		const sandbox = sandboxWith(async function* () {
			yield { path: `${ROOT}/first.ts`, size: 7 }
		})
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(true)
		expect(result.data).toMatchObject({ totalMatches: 1, filesSearched: 1, truncated: false })
		expect(result.output).not.toContain('incomplete')
	})

	it('retains prior matches and closes traversal when cancelled during a remote read', async () => {
		const controller = new AbortController()
		let closed = false
		const sandbox = sandboxWith(async function* () {
			try {
				yield { path: `${ROOT}/first.ts`, size: 7 }
				yield { path: `${ROOT}/pending.ts`, size: 7 }
				yield { path: `${ROOT}/never.ts`, size: 7 }
			} finally {
				closed = true
			}
		})
		let announceRead!: () => void
		const reading = new Promise<void>((resolve) => {
			announceRead = resolve
		})
		let settleRead!: (buffer: Buffer) => void
		sandbox.readFile.mockResolvedValueOnce(Buffer.from('needle\n')).mockImplementationOnce(() => {
			announceRead()
			return new Promise<Buffer>((resolve) => {
				settleRead = resolve
			})
		})
		const pending = GrepTool.execute(args(), context(sandbox, controller.signal))
		await reading
		controller.abort(new Error('Operator stopped the search'))
		try {
			const result = await pending
			expect(result.success).toBe(false)
			expect(result.output).toContain('./first.ts:1:needle')
			expect(result.output).toContain('Search incomplete: Operator stopped the search')
			expect(result.data).toMatchObject({ totalMatches: 1, truncated: true })
			expect(closed).toBe(true)
			expect(sandbox.readFile).toHaveBeenCalledTimes(2)
		} finally {
			settleRead(Buffer.from('needle LATE_BUFFER'))
		}
	})

	it('does no traversal or reading when already cancelled', async () => {
		const controller = new AbortController()
		controller.abort(new Error('Stopped before search'))
		const sandbox = sandboxWith(async function* () {
			yield { path: `${ROOT}/first.ts`, size: 7 }
		})
		const result = await GrepTool.execute(args(), context(sandbox, controller.signal))
		expect(result.success).toBe(false)
		expect(sandbox.walkFiles).not.toHaveBeenCalled()
		expect(sandbox.readFile).not.toHaveBeenCalled()
	})

	it('never reads an absolute entry outside the selected search root', async () => {
		const sandbox = sandboxWith(async function* () {
			yield { path: '/sandbox/other/private.ts', size: 7 }
		})
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(false)
		expect(result.error).toContain('escapes the working directory')
		expect(sandbox.readFile).not.toHaveBeenCalled()
	})

	it('refuses unsupported sandbox adapters without an eager or host fallback', async () => {
		const sandbox = sandboxWith(async function* () {})
		Reflect.deleteProperty(sandbox, 'walkFiles')
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(false)
		expect(result.error).toContain('Sandbox.walkFiles')
		expect(sandbox.listFiles).not.toHaveBeenCalled()
		expect(sandbox.readFile).not.toHaveBeenCalled()
	})

	it('skips files known to exceed the read limit before loading their contents', async () => {
		const sandbox = sandboxWith(async function* () {
			yield { path: `${ROOT}/large.ts`, size: 5 * 1024 * 1024 + 1 }
			yield { path: `${ROOT}/small.ts`, size: 7 }
		})
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(true)
		expect(sandbox.readFile).toHaveBeenCalledExactlyOnceWith(`${ROOT}/small.ts`)
	})

	it('preserves readable matches while reporting unreadable files as incomplete', async () => {
		const sandbox = sandboxWith(async function* () {
			yield { path: `${ROOT}/first.ts`, size: 7 }
			yield { path: `${ROOT}/denied.ts`, size: 7 }
		})
		sandbox.readFile
			.mockResolvedValueOnce(Buffer.from('needle'))
			.mockRejectedValueOnce(new Error('denied'))
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(false)
		expect(result.output).toContain('./first.ts:1:needle')
		expect(result.output).toContain('1 file(s) could not be read')
		expect(result.data).toMatchObject({ totalMatches: 1, truncated: true })
	})

	it('keeps recursive brace includes, case handling, and context on the real local walker', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-grep-include-'))
		temporary.push(root)
		await mkdir(join(root, 'src', 'nested'), { recursive: true })
		await writeFile(join(root, 'src', 'nested', 'match.ts'), 'before\nNEEDLE\nafter\n')
		await writeFile(join(root, 'src', 'skip.md'), 'needle excluded')
		const ctx = { workingDirectory: root, abortSignal: new AbortController().signal } as ToolContext
		const result = await GrepTool.execute(
			args({ include: '*.{ts,js}', case_sensitive: false, context_lines: 1 }),
			ctx,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('./src/nested/match.ts-1-before')
		expect(result.output).toContain('./src/nested/match.ts:2:NEEDLE')
		expect(result.output).toContain('./src/nested/match.ts-3-after')
		expect(result.output).not.toContain('excluded')
		expect(result.data).toMatchObject({ totalMatches: 1, filesSearched: 1, truncated: false })
	})

	it('preserves sandbox wildcard dotfile searches through the shared walker', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-grep-dot-'))
		temporary.push(root)
		await writeFile(join(root, '.history'), 'needle')
		const sandbox = {
			rootDir: root,
			walkFiles: (path: string, options: SandboxWalkFilesOptions) =>
				walkFilesLocally(path, options),
			readFile: async () => Buffer.from('needle'),
		} as unknown as Sandbox
		const result = await GrepTool.execute(args(), context(sandbox))
		expect(result.success).toBe(true)
		expect(result.output).toContain('./.history:1:needle')
	})

	it.skipIf(process.platform === 'win32')(
		'refuses an escaped root symlink and skips descendant symlinks',
		async () => {
			const base = await mkdtemp(join(tmpdir(), 'namzu-grep-links-'))
			temporary.push(base)
			const root = join(base, 'workspace')
			const outside = join(base, 'outside')
			await mkdir(root)
			await mkdir(outside)
			await writeFile(join(outside, 'private.ts'), 'needle PRIVATE_CONTENT')
			await symlink(outside, join(root, 'linked'))
			const ctx = {
				workingDirectory: root,
				abortSignal: new AbortController().signal,
			} as ToolContext
			const broad = await GrepTool.execute(args(), ctx)
			const escaped = await GrepTool.execute(args({ path: 'linked' }), ctx)
			expect(broad.success).toBe(true)
			expect(broad.data).toMatchObject({ totalMatches: 0, truncated: false })
			expect(escaped.success).toBe(false)
			expect(JSON.stringify([broad, escaped])).not.toContain('PRIVATE_CONTENT')
		},
	)
})
