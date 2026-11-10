import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { walkFilesViaExec } from '../../sandbox/file-walk.js'
import type { Sandbox, SandboxWalkFilesOptions } from '../../types/sandbox/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { GlobTool } from '../builtins/glob.js'
import { ReadFileTool } from '../builtins/read-file.js'

const temporary: string[] = []
afterEach(() => {
	for (const root of temporary.splice(0)) removeTempDir(root)
})

function context(sandbox?: Sandbox, workingDirectory = '/host/project'): ToolContext {
	return { workingDirectory, sandbox, abortSignal: new AbortController().signal } as ToolContext
}

function sandboxWith(files: readonly string[]) {
	const listFiles = vi.fn(async () => files.map((path) => ({ path, size: 1 })))
	const walkFiles = vi.fn(async function* (_root?: string, _options?: { signal?: AbortSignal }) {
		for (const path of files) yield { path, size: 1 }
	})
	return {
		rootDir: '/sandbox/project',
		listFiles,
		walkFiles,
	} as unknown as Sandbox & { listFiles: typeof listFiles; walkFiles: typeof walkFiles }
}

describe('a pattern that could backtrack without end is a tool error', () => {
	it('glob returns the refusal to the model and never runs a guest script', async () => {
		const exec = vi.fn()
		const sandbox = {
			rootDir: '/sandbox/project',
			walkFiles: (root: string, options: SandboxWalkFilesOptions) =>
				walkFilesViaExec(exec, root, options),
		} as unknown as Sandbox
		const result = await GlobTool.execute({ pattern: '*(*(a))', path: '.' }, context(sandbox))
		expect(exec).not.toHaveBeenCalled()
		expect(result.success).toBe(false)
		expect(result.error).toContain('repeats a group that can match the same text more than one way')
		expect(result.error).toContain('use ** or {a,b} instead')
	})
	it('glob refuses it on the host walk too', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-glob-refuse-'))
		temporary.push(root)
		await writeFile(join(root, 'a'), '')
		const result = await GlobTool.execute(
			{ pattern: '+(a|aa)', path: root },
			context(undefined, root),
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain("The pattern '+(a|aa)' repeats a group")
	})
})

describe('glob keeps the requested search scope', () => {
	it('a plain star lists immediate files without entering a nested project', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-glob-scope-'))
		temporary.push(root)
		await mkdir(join(root, 'nested'))
		await writeFile(join(root, 'README.md'), 'root')
		await writeFile(join(root, 'nested', 'package.json'), '{}')
		const result = await GlobTool.execute({ pattern: '*', path: root }, context(undefined, root))
		expect(result.success).toBe(true)
		expect(result.data).toMatchObject({ files: ['README.md'], truncated: false })
		expect(result.output).not.toContain('nested')
	})

	it('explicit recursive syntax still finds files below the selected directory', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-glob-recursive-'))
		temporary.push(root)
		await mkdir(join(root, 'src', 'nested'), { recursive: true })
		await writeFile(join(root, 'src', 'a.ts'), '')
		await writeFile(join(root, 'src', 'nested', 'b.ts'), '')
		const result = await GlobTool.execute(
			{ pattern: '**/*.ts', path: 'src' },
			context(undefined, root),
		)
		expect(result.success).toBe(true)
		expect((result.data as { files: string[] }).files.sort()).toEqual([
			'src/a.ts',
			'src/nested/b.ts',
		])
	})

	it('finds hidden files by default and leaves them out on request', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-glob-hidden-'))
		temporary.push(root)
		await writeFile(join(root, '.env'), 'fixture only')
		await writeFile(join(root, 'README.md'), '')
		const ordinary = await GlobTool.execute(
			{ pattern: '*', include_hidden: false },
			context(undefined, root),
		)
		const named = await GlobTool.execute({ pattern: '.env' }, context(undefined, root))
		const all = await GlobTool.execute({ pattern: '*' }, context(undefined, root))
		expect(ordinary.data).toMatchObject({ files: ['README.md'] })
		expect(named.data).toMatchObject({ files: ['.env'] })
		expect((all.data as { files: string[] }).files.sort()).toEqual(['.env', 'README.md'])
	})

	it.skipIf(process.platform === 'win32')(
		'accepts an absolute pattern through the working directory alias',
		async () => {
			const base = await mkdtemp(join(tmpdir(), 'namzu-glob-alias-'))
			temporary.push(base)
			const real = join(base, 'real')
			const alias = join(base, 'alias')
			await mkdir(real)
			await writeFile(join(real, 'a.ts'), '')
			await symlink(real, alias)
			const result = await GlobTool.execute({ pattern: `${alias}/*.ts` }, context(undefined, alias))
			expect(result.success).toBe(true)
			expect(result.data).toMatchObject({ files: ['a.ts'] })
		},
	)

	it('uses incremental sandbox enumeration and reports absolute entries once', async () => {
		const sandbox = sandboxWith(['/sandbox/project/README.md'])
		const result = await GlobTool.execute({ pattern: '*' }, context(sandbox))
		expect(sandbox.listFiles).not.toHaveBeenCalled()
		expect(sandbox.walkFiles).toHaveBeenCalledWith(
			'/sandbox/project',
			expect.objectContaining({ pattern: '*', maxEntries: 501 }),
		)
		expect(result.success).toBe(true)
		expect(result.output).toBe('README.md')
	})

	it.skipIf(process.platform === 'win32')(
		'returns readable paths from an added directory when cwd is an alias',
		async () => {
			const base = await mkdtemp(join(tmpdir(), 'namzu-glob-added-alias-'))
			temporary.push(base)
			const real = join(base, 'real', 'deep')
			const alias = join(base, 'alias')
			const added = join(base, 'extra')
			await mkdir(real, { recursive: true })
			await mkdir(added)
			await symlink(real, alias)
			await writeFile(join(added, 'proof.txt'), 'readable through the selected root')
			const ctx = { ...context(undefined, alias), additionalDirectories: [added] }
			const found = await GlobTool.execute({ pattern: '*', path: added }, ctx)
			expect(found.success).toBe(true)
			const files = (found.data as { files: string[] }).files
			expect(files).toHaveLength(1)
			const read = await ReadFileTool.execute({ path: files[0] as string }, ctx)
			expect(read.success).toBe(true)
			expect(read.output).toContain('readable through the selected root')
		},
	)

	it('resolves the pattern against input.path and keeps reader-compatible paths', async () => {
		const sandbox = sandboxWith(['/sandbox/project/src/a.ts'])
		const result = await GlobTool.execute({ pattern: '*.ts', path: 'src' }, context(sandbox))
		expect(sandbox.walkFiles).toHaveBeenCalledWith(
			'/sandbox/project/src',
			expect.objectContaining({ pattern: '*.ts' }),
		)
		expect(result.output).toBe('src/a.ts')
	})

	it('accepts a contained absolute pattern without duplicating its root', async () => {
		const sandbox = sandboxWith(['/sandbox/project/src/a.ts'])
		const result = await GlobTool.execute(
			{ pattern: '/sandbox/project/src/*.ts' },
			context(sandbox),
		)
		expect(sandbox.walkFiles).toHaveBeenCalledWith(
			'/sandbox/project',
			expect.objectContaining({ pattern: 'src/*.ts' }),
		)
		expect(result.output).toBe('src/a.ts')
	})

	it.each(['../secret/*', '/elsewhere/*', 'src/../../secret/*'])(
		'refuses an escaping pattern %s before enumeration',
		async (pattern) => {
			const sandbox = sandboxWith([])
			const result = await GlobTool.execute({ pattern }, context(sandbox))
			expect(result.success).toBe(false)
			expect(sandbox.walkFiles).not.toHaveBeenCalled()
			expect(sandbox.listFiles).not.toHaveBeenCalled()
		},
	)

	it('reports a result cap and closes the iterator without consuming its tail', async () => {
		let closed = false
		const sandbox = sandboxWith([])
		sandbox.walkFiles.mockImplementation(async function* () {
			try {
				for (let i = 0; i < 501; i++) yield { path: `/sandbox/project/f${i}.ts`, size: 1 }
				throw new Error('consumed beyond the bounded preview')
			} finally {
				closed = true
			}
		})
		const result = await GlobTool.execute({ pattern: '**/*.ts' }, context(sandbox))
		expect(result.success).toBe(true)
		expect(result.data).toMatchObject({ count: 500, truncated: true })
		expect(result.output).toMatch(/500.*narrow/i)
		expect(closed).toBe(true)
	})

	it('reports a walker that still throws the old entry limit as a partial result, not a failure', async () => {
		const sandbox = sandboxWith([])
		sandbox.walkFiles.mockImplementation(async function* () {
			yield { path: '/sandbox/project/found.ts', size: 1 }
			throw Object.assign(new Error('Search stopped after 20000 entries; narrow the directory.'), {
				code: 'ERR_FILE_WALK_LIMIT',
			})
		})
		const result = await GlobTool.execute({ pattern: '**/*.ts' }, context(sandbox))
		expect(result.success).toBe(true)
		expect(result.error).toBeUndefined()
		expect(result.data).toMatchObject({ count: 1, truncated: true })
		expect(result.output).toContain('found.ts')
		expect(result.output).toContain('Search stopped early')
		expect(result.output).not.toContain('No files found')
	})

	it('refuses a sandbox without bounded search instead of starting an eager inventory', async () => {
		const sandbox = sandboxWith([])
		;(sandbox as { walkFiles?: unknown }).walkFiles = undefined
		const result = await GlobTool.execute({ pattern: '**/*' }, context(sandbox))
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/bounded.*file|walkFiles/i)
		expect(sandbox.listFiles).not.toHaveBeenCalled()
	})

	it('forwards caller cancellation to the sandbox walker', async () => {
		const sandbox = sandboxWith(['/sandbox/project/a.ts'])
		const caller = new AbortController()
		const ctx = { ...context(sandbox), abortSignal: caller.signal }
		let walkerSignal: AbortSignal | undefined
		sandbox.walkFiles.mockImplementation(async function* (_root, options) {
			walkerSignal = options?.signal
			await new Promise<void>((resolve) =>
				options?.signal?.addEventListener('abort', () => resolve()),
			)
			options?.signal?.throwIfAborted()
		})
		const running = GlobTool.execute({ pattern: '*' }, ctx)
		await vi.waitFor(() => expect(walkerSignal).toBeDefined())
		caller.abort(new Error('stop'))
		await running
		expect(walkerSignal?.aborted).toBe(true)
	})

	it('names both the pattern and directory in the tool call view', () => {
		expect(GlobTool.presentCall?.({ pattern: '*', path: '/home/arda' })).toEqual({
			kind: 'generic',
			label: 'Find * in /home/arda',
			presentation: 'activity',
			activity: 'exploration',
			facts: { kind: 'list', pattern: '*', path: '/home/arda' },
		})
	})
})
