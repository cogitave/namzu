import { mkdir, mkdtemp, realpath, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { walkFilesLocally } from '../../sandbox/file-walk.js'
import type {
	Sandbox,
	SandboxFileEntry,
	SandboxWalkFilesOptions,
	SandboxWalkSummary,
} from '../../types/sandbox/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { GlobTool } from '../builtins/glob.js'
import { GrepTool } from '../builtins/grep.js'
import { hostDisplayPath } from '../builtins/search-support.js'

const dirs: string[] = []
const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME }
beforeEach(async () => {
	const home = await realpath(await mkdtemp(join(tmpdir(), 'namzu-search-home-')))
	dirs.push(home)
	process.env.HOME = home
	process.env.XDG_CONFIG_HOME = join(home, '.config')
})
afterEach(async () => {
	vi.useRealTimers()
	process.env.HOME = saved.home
	if (saved.xdg === undefined) Reflect.deleteProperty(process.env, 'XDG_CONFIG_HOME')
	else process.env.XDG_CONFIG_HOME = saved.xdg
	await removeTempDirs(dirs)
	dirs.length = 0
})

const grepArgs = (extra: object = {}) => ({
	pattern: 'query/iteration',
	case_sensitive: true,
	context_lines: 0,
	output_mode: 'files_with_matches' as const,
	offset: 0,
	...extra,
})
const hostContext = (workingDirectory: string) =>
	({ workingDirectory, abortSignal: new AbortController().signal }) as ToolContext

async function put(root: string, name: string, text = ''): Promise<void> {
	const target = join(root, name)
	await mkdir(dirname(target), { recursive: true })
	await writeFile(target, text)
}

/** Many small files, written in batches so the fixture does not exhaust file handles. */
async function putMany(root: string, directory: string, count: number, text = 'x'): Promise<void> {
	await mkdir(join(root, directory), { recursive: true })
	for (let start = 0; start < count; start += 500) {
		await Promise.all(
			Array.from({ length: Math.min(500, count - start) }, (_, offset) =>
				writeFile(join(root, directory, `f${start + offset}.ts`), text),
			),
		)
	}
}

/**
 * The shape of a real checkout: ignored build output, coverage, dependencies
 * and a nested worktree, together holding more files than the old 20,000-entry
 * bound allowed, next to twenty source files of which three mention the pattern.
 */
async function ownerRepository(): Promise<{ parent: string; repo: string }> {
	const parent = await realpath(await mkdtemp(join(tmpdir(), 'namzu-search-owner-')))
	dirs.push(parent)
	const repo = join(parent, 'namzu')
	await put(repo, '.git/HEAD', 'ref: refs/heads/main')
	await put(repo, '.gitignore', 'node_modules/\ndist/\ncoverage/\n.claude/worktrees/\n')
	for (let index = 0; index < 20; index += 1) {
		await put(repo, `src/mod${index}.ts`, index < 3 ? "import 'query/iteration'\n" : 'export {}\n')
	}
	await putMany(repo, 'dist/sdk', 21_000, 'query/iteration')
	await putMany(repo, 'coverage/lcov', 1_000, 'query/iteration')
	await put(repo, 'node_modules/pkg/index.js', 'query/iteration')
	await put(repo, '.claude/worktrees/w1/.git', 'gitdir: elsewhere')
	await put(repo, '.claude/worktrees/w1/src/a.ts', 'query/iteration')
	await putMany(repo, '.claude/worktrees/w1/node_modules/dep', 1_000, 'query/iteration')
	return { parent, repo }
}

describe('searching a repository that ignores its build output', () => {
	// The fixture writes about 24,000 real files: slow filesystem work, not a wait on time.
	it('finds only the unignored files from the repository root, and succeeds', async () => {
		const { parent, repo } = await ownerRepository()
		const result = await GrepTool.execute(grepArgs({ path: repo }), hostContext(parent))
		expect(result.success).toBe(true)
		expect(result.error).toBeUndefined()
		const lines = result.output.split('\n').filter((line) => line.startsWith('namzu/'))
		expect(lines.sort()).toEqual(['namzu/src/mod0.ts', 'namzu/src/mod1.ts', 'namzu/src/mod2.ts'])
		expect(result.output).not.toContain('dist')
		expect(result.output).not.toContain('Search stopped early')
		expect(result.data).toMatchObject({ filesMatched: 3, truncated: false })
		expect((result.data as { filesSearched: number }).filesSearched).toBeLessThan(40)
	}, 60_000)

	it('does the same when the search starts above the repository', async () => {
		const { parent } = await ownerRepository()
		const result = await GrepTool.execute(grepArgs(), hostContext(parent))
		expect(result.success).toBe(true)
		expect(
			result.output
				.split('\n')
				.filter((line) => line.includes('/src/mod'))
				.sort(),
		).toEqual(['namzu/src/mod0.ts', 'namzu/src/mod1.ts', 'namzu/src/mod2.ts'])
		expect(result.output).not.toContain('Search stopped early')
	}, 60_000)

	it('examines a small fraction of the tree, and glob lists only source files', async () => {
		const { parent, repo } = await ownerRepository()
		let summary: SandboxWalkSummary | undefined
		for await (const _ of walkFilesLocally(repo, {
			pattern: '**/*',
			maxEntries: 100_000,
			onSummary: (value) => {
				summary = value
			},
		}));
		expect((summary as SandboxWalkSummary | undefined)?.visited).toBeLessThan(60)
		const glob = await GlobTool.execute({ pattern: '**/*.ts', path: repo }, hostContext(parent))
		expect(glob.success).toBe(true)
		expect((glob.data as { count: number }).count).toBe(20)
		expect(glob.output).not.toContain('dist')
		expect(glob.output).not.toContain('Search stopped early')
	}, 60_000)

	it('searches the ignored tree on request, and when it is named as the search root', async () => {
		const { parent, repo } = await ownerRepository()
		const named = await GrepTool.execute(
			grepArgs({ path: join(repo, 'node_modules'), head_limit: 5 }),
			hostContext(parent),
		)
		expect(named.output).toContain('namzu/node_modules/pkg/index.js')
		const requested = await GrepTool.execute(
			grepArgs({ path: repo, include_ignored: true, head_limit: 0, include: 'index.js' }),
			hostContext(parent),
		)
		expect(requested.output).toContain('namzu/node_modules/pkg/index.js')
	}, 60_000)
})

describe('a limit is a normal result', () => {
	it('returns a full page of files as a success with a note that more exist', async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'namzu-search-limit-')))
		dirs.push(parent)
		await putMany(parent, 'src', 300, 'query/iteration')
		const result = await GrepTool.execute(grepArgs({ head_limit: 100 }), hostContext(parent))
		expect(result.success).toBe(true)
		expect(result.error).toBeUndefined()
		expect(result.output).toContain('Found 100 files (limit: 100)')
		expect(result.output).toContain('More results are available')
		expect(result.facts).toMatchObject({ limited: true })
	})

	it('caps a glob at 500 files as a success', async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'namzu-search-glob-')))
		dirs.push(parent)
		await putMany(parent, 'src', 520)
		const result = await GlobTool.execute({ pattern: '**/*.ts' }, hostContext(parent))
		expect(result.success).toBe(true)
		expect(result.error).toBeUndefined()
		expect(result.output).toContain('Showing the first 500 matching files')
		expect(result.facts).toMatchObject({ kind: 'list', limited: true })
	})

	it('says an empty result skipped ignored directories', async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'namzu-search-empty-')))
		dirs.push(parent)
		await put(parent, '.git/HEAD', '')
		await put(parent, '.gitignore', 'dist/\n')
		await put(parent, 'dist/a.js', 'query/iteration')
		const result = await GrepTool.execute(grepArgs(), hostContext(parent))
		expect(result.success).toBe(true)
		expect(result.output).toContain('No matches found')
		expect(result.output).toContain('1 ignored directory skipped')
		expect(result.output).toContain('include_ignored: true')
	})

	it('orders a file list newest first among the files it reads', async () => {
		const parent = await realpath(await mkdtemp(join(tmpdir(), 'namzu-search-order-')))
		dirs.push(parent)
		await put(parent, 'old.ts', 'needle')
		await put(parent, 'new.ts', 'needle')
		await utimes(join(parent, 'old.ts'), new Date(1_000_000), new Date(1_000_000))
		const result = await GrepTool.execute(grepArgs({ pattern: 'needle' }), hostContext(parent))
		expect(result.output.split('\n').slice(1, 3)).toEqual(['new.ts', 'old.ts'])
	})
})

// A walker that reports how it ended, as every in-tree walker does.
function sandboxWalking(
	walk: (options: SandboxWalkFilesOptions) => AsyncIterable<SandboxFileEntry>,
	summary?: SandboxWalkSummary,
) {
	return {
		rootDir: '/sandbox/project',
		walkFiles: vi.fn((_root: string, options: SandboxWalkFilesOptions) => {
			const source = walk(options)
			return (async function* () {
				try {
					yield* source
				} finally {
					if (summary) options.onSummary?.(summary)
				}
			})()
		}),
		readFile: vi.fn(async () => Buffer.from('needle\n')),
	} as unknown as Sandbox
}
const sandboxContext = (sandbox: Sandbox) =>
	({
		sandbox,
		workingDirectory: '/host/elsewhere',
		abortSignal: new AbortController().signal,
	}) as ToolContext

describe('the walk reaches its bound or its time budget', () => {
	it('keeps the matches and says the search stopped early when the entry bound was hit', async () => {
		const sandbox = sandboxWalking(
			async function* () {
				yield { path: '/sandbox/project/a.ts', size: 7 }
			},
			{ visited: 500_000, ignoredDirectories: 0, stopped: 'entry-limit' },
		)
		for (const result of [
			await GrepTool.execute(grepArgs({ pattern: 'needle' }), sandboxContext(sandbox)),
			await GlobTool.execute({ pattern: '**/*.ts' }, sandboxContext(sandbox)),
		]) {
			expect(result.success).toBe(true)
			expect(result.error).toBeUndefined()
			expect(result.output).toContain('a.ts')
			expect(result.output).toContain('Search stopped early after examining 500,000 entries')
			expect(result.facts).toMatchObject({ incomplete: true })
		}
	})

	it('asks the walker to respect ignore rules unless include_ignored is set', async () => {
		const sandbox = sandboxWalking(async function* () {})
		await GrepTool.execute(grepArgs(), sandboxContext(sandbox))
		await GrepTool.execute(grepArgs({ include_ignored: true }), sandboxContext(sandbox))
		await GlobTool.execute({ pattern: '*', include_ignored: true }, sandboxContext(sandbox))
		const calls = (sandbox.walkFiles as unknown as ReturnType<typeof vi.fn>).mock.calls
		expect(calls.map(([, options]) => (options as SandboxWalkFilesOptions).respectIgnore)).toEqual([
			true,
			false,
			false,
		])
	})

	it('returns what it found when the time budget runs out, as a success', async () => {
		vi.useFakeTimers()
		const sandbox = sandboxWalking(async function* (options) {
			yield { path: '/sandbox/project/a.ts', size: 7 }
			await new Promise<void>((resolve) =>
				options.signal?.addEventListener('abort', () => resolve()),
			)
			options.signal?.throwIfAborted()
		})
		const running = GrepTool.execute(grepArgs({ pattern: 'needle' }), sandboxContext(sandbox))
		await vi.waitFor(() => expect(sandbox.readFile).toHaveBeenCalled())
		await vi.advanceTimersByTimeAsync(12_000)
		const result = await running
		expect(result.success).toBe(true)
		expect(result.output).toContain('a.ts')
		expect(result.output).toContain('Search stopped early after 12 seconds')
	})

	it('stays an error when the time budget runs out with nothing found', async () => {
		vi.useFakeTimers()
		const sandbox = sandboxWalking(async function* (options) {
			await new Promise<void>((resolve) =>
				options.signal?.addEventListener('abort', () => resolve()),
			)
			options.signal?.throwIfAborted()
		})
		for (const run of [
			() => GrepTool.execute(grepArgs(), sandboxContext(sandbox)),
			() => GlobTool.execute({ pattern: '**/*' }, sandboxContext(sandbox)),
		]) {
			const running = run()
			await vi.advanceTimersByTimeAsync(12_000)
			const result = await running
			expect(result.success).toBe(false)
			expect(result.error).toContain('timed out after 12 seconds')
		}
	})
})

describe('how a path is shown', () => {
	it('is relative to the working directory under it, absolute elsewhere, and never ./', () => {
		expect(hostDisplayPath('/home/arda', '/home/arda/work/a.ts')).toBe('work/a.ts')
		expect(hostDisplayPath('/home/arda/work', '/home/arda/other/a.ts')).toBe(
			'/home/arda/other/a.ts',
		)
		expect(hostDisplayPath('/home/arda', '/home/arda')).toBe('.')
		expect(hostDisplayPath('/home/arda/work', '/etc/hosts')).toBe('/etc/hosts')
	})
})
