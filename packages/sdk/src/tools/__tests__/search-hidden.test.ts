import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type {
	Sandbox,
	SandboxFileEntry,
	SandboxWalkFilesOptions,
} from '../../types/sandbox/index.js'
import type { ToolContext } from '../../types/tool/index.js'
import { GlobTool } from '../builtins/glob.js'
import { GrepTool } from '../builtins/grep.js'
import { isReadDenied } from '../builtins/search-support.js'

const dirs: string[] = []
const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME }
beforeEach(async () => {
	const home = await realpath(await mkdtemp(join(tmpdir(), 'namzu-hidden-home-')))
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
	pattern: 'needle',
	case_sensitive: true,
	context_lines: 0,
	output_mode: 'files_with_matches' as const,
	offset: 0,
	...extra,
})
const hostContext = (workingDirectory: string, readDenied?: (path: string) => boolean) =>
	({
		workingDirectory,
		abortSignal: new AbortController().signal,
		...(readDenied ? { readDenied } : {}),
	}) as ToolContext

async function put(root: string, name: string, text = ''): Promise<void> {
	const target = join(root, name)
	await mkdir(dirname(target), { recursive: true })
	await writeFile(target, text)
}

async function workspace(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-hidden-')))
	dirs.push(root)
	return root
}

const lines = (output: string): string[] =>
	output
		.split('\n')
		.filter((line) => line.includes('.') && !line.startsWith('Found') && !line.startsWith('('))
		.sort()

describe('hidden files are searched by default', () => {
	it('finds a hidden file and one inside a hidden directory, in grep and glob', async () => {
		const root = await workspace()
		await put(root, '.hidden.txt', 'needle')
		await put(root, '.config/app/settings.json', 'needle')
		await put(root, 'visible.txt', 'needle')
		const grep = await GrepTool.execute(grepArgs(), hostContext(root))
		expect(lines(grep.output)).toEqual(['.config/app/settings.json', '.hidden.txt', 'visible.txt'])
		const glob = await GlobTool.execute({ pattern: '**/*' }, hostContext(root))
		expect(lines(glob.output)).toEqual(['.config/app/settings.json', '.hidden.txt', 'visible.txt'])
	})

	it('opts out with include_hidden: false', async () => {
		const root = await workspace()
		await put(root, '.hidden.txt', 'needle')
		await put(root, '.config/app/settings.json', 'needle')
		await put(root, 'visible.txt', 'needle')
		const grep = await GrepTool.execute(grepArgs({ include_hidden: false }), hostContext(root))
		expect(lines(grep.output)).toEqual(['visible.txt'])
		const glob = await GlobTool.execute(
			{ pattern: '**/*', include_hidden: false },
			hostContext(root),
		)
		expect(lines(glob.output)).toEqual(['visible.txt'])
	})

	it('never enters a version-control directory, in a repository or not', async () => {
		const root = await workspace()
		await put(root, '.git/config', 'needle')
		await put(root, '.hg/store', 'needle')
		await put(root, '.svn/entries', 'needle')
		await put(root, '.jj/repo', 'needle')
		await put(root, 'src/.git', 'gitdir: elsewhere needle')
		await put(root, 'real.txt', 'needle')
		const grep = await GrepTool.execute(grepArgs(), hostContext(root))
		expect(lines(grep.output)).toEqual(['real.txt'])
		const glob = await GlobTool.execute({ pattern: '**/*' }, hostContext(root))
		expect(lines(glob.output)).toEqual(['real.txt'])
	})

	it('keeps a gitignored .env out, and reaches it only when asked', async () => {
		const root = await workspace()
		await put(root, '.git/HEAD', 'ref: refs/heads/main')
		await put(root, '.gitignore', '.env\n')
		await put(root, '.env', 'needle')
		await put(root, '.env.example', 'needle')
		const grep = await GrepTool.execute(grepArgs(), hostContext(root))
		expect(lines(grep.output)).toEqual(['.env.example'])
		const glob = await GlobTool.execute({ pattern: '.env*' }, hostContext(root))
		expect(lines(glob.output)).toEqual(['.env.example'])
		const asked = await GrepTool.execute(grepArgs({ include_ignored: true }), hostContext(root))
		expect(lines(asked.output)).toEqual(['.env', '.env.example'])
	})
})

describe('a read-deny rule hides a path from search', () => {
	const denied = (path: string) => /(^|\/)(\.env|secrets)(\/|$)/.test(path)

	it('lists neither the file nor its contents, in every output mode', async () => {
		const root = await workspace()
		await put(root, '.env', 'needle SECRET_VALUE')
		await put(root, 'secrets/key.pem', 'needle SECRET_VALUE')
		await put(root, 'ok.txt', 'needle fine')
		for (const mode of ['files_with_matches', 'content', 'count'] as const) {
			const result = await GrepTool.execute(
				grepArgs({ output_mode: mode }),
				hostContext(root, denied),
			)
			expect(result.success).toBe(true)
			expect(result.output).toContain('ok.txt')
			expect(result.output).not.toContain('SECRET_VALUE')
			expect(result.output).not.toContain('.env')
			expect(result.output).not.toContain('secrets')
		}
		const glob = await GlobTool.execute({ pattern: '**/*' }, hostContext(root, denied))
		expect(lines(glob.output)).toEqual(['ok.txt'])
		expect((glob.data as { count: number }).count).toBe(1)
	})

	it('hands the rule absolute host paths, and never opens a denied file in a sandbox', async () => {
		const asked: string[] = []
		const sandbox = {
			rootDir: '/sandbox/project',
			walkFiles: vi.fn((_root: string, _options: SandboxWalkFilesOptions) =>
				(async function* (): AsyncGenerator<SandboxFileEntry> {
					yield { path: '/sandbox/project/.env', size: 6 }
					yield { path: '/sandbox/project/a.txt', size: 6 }
				})(),
			),
			readFile: vi.fn(async () => Buffer.from('needle\n')),
		} as unknown as Sandbox
		const context = {
			sandbox,
			workingDirectory: '/host/project',
			abortSignal: new AbortController().signal,
			readDenied: (path: string) => {
				asked.push(path)
				return path.endsWith('.env')
			},
		} as ToolContext
		const result = await GrepTool.execute(grepArgs(), context)
		expect(result.output).toContain('a.txt')
		expect(result.output).not.toContain('.env')
		expect(asked).toEqual(['/host/project/.env', '/host/project/a.txt'])
		expect(sandbox.readFile).toHaveBeenCalledTimes(1)
		expect(sandbox.readFile).toHaveBeenCalledWith('/sandbox/project/a.txt', expect.anything())
	})
})

describe('a home directory full of hidden caches', () => {
	it('returns a real hidden cache as a normal result next to the files it holds', async () => {
		const home = await workspace()
		for (let batch = 0; batch < 6; batch += 1) {
			await Promise.all(
				Array.from({ length: 500 }, (_, index) =>
					put(home, `.cache/pkg${batch}/f${index}.bin`, 'no match here'),
				),
			)
		}
		await put(home, '.local/share/notes.txt', 'needle')
		await put(home, 'doc.txt', 'needle')
		const result = await GrepTool.execute(grepArgs(), hostContext(home))
		expect(result.success).toBe(true)
		expect(lines(result.output)).toEqual(['.local/share/notes.txt', 'doc.txt'])
		expect(result.output).not.toContain('Search stopped early')
	}, 60_000)

	it('keeps the matches and says the search stopped when the time budget ends inside a huge hidden directory', async () => {
		vi.useFakeTimers()
		const sandbox = {
			rootDir: '/home/user',
			walkFiles: vi.fn((_root: string, options: SandboxWalkFilesOptions) =>
				(async function* (): AsyncGenerator<SandboxFileEntry> {
					yield { path: '/home/user/doc.txt', size: 7 }
					// The walk is now inside ~/.cache and never comes out.
					await new Promise<void>((resolve) =>
						options.signal?.addEventListener('abort', () => resolve()),
					)
					options.signal?.throwIfAborted()
				})(),
			),
			readFile: vi.fn(async () => Buffer.from('needle\n')),
		} as unknown as Sandbox
		const context = {
			sandbox,
			workingDirectory: '/home/user',
			abortSignal: new AbortController().signal,
		} as ToolContext
		const running = GrepTool.execute(grepArgs(), context)
		await vi.waitFor(() => expect(sandbox.readFile).toHaveBeenCalled())
		await vi.advanceTimersByTimeAsync(12_000)
		const result = await running
		expect(result.success).toBe(true)
		expect(result.output).toContain('doc.txt')
		expect(result.output).toContain('Search stopped early after 12 seconds')
		expect(result.facts).toMatchObject({ incomplete: true })
	})
})

describe('a sandbox path outside the bound folder', () => {
	it('is denied without asking the rule, because it has no host counterpart', () => {
		const asked: string[] = []
		const context = {
			workingDirectory: '/host/project',
			readDenied: (path: string) => {
				asked.push(path)
				return false
			},
		}
		expect(isReadDenied(context, '/sandbox/elsewhere/.env', '/sandbox/project')).toBe(true)
		expect(isReadDenied(context, '/sandbox/project-two/a.txt', '/sandbox/project')).toBe(true)
		expect(isReadDenied(context, '/sandbox/project/a.txt', '/sandbox/project')).toBe(false)
		expect(asked).toEqual(['/host/project/a.txt'])
	})
})
