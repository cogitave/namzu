import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type {
	SandboxFileEntry,
	SandboxWalkFilesOptions,
	SandboxWalkSummary,
} from '../../types/sandbox/index.js'
import { type SandboxFileWalkExec, walkFilesLocally, walkFilesViaExec } from '../file-walk.js'

const execAsync = promisify(execFile)
const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})
const exec: SandboxFileWalkExec = async (command, argv, options) => {
	expect(command).toBe('node')
	try {
		const result = await execAsync(process.execPath, argv, {
			signal: options?.signal,
			maxBuffer: 1024 * 1024,
		})
		return {
			exitCode: 0,
			stdout: result.stdout,
			stderr: result.stderr,
			timedOut: false,
			durationMs: 0,
		}
	} catch (error) {
		const result = error as Error & { code?: number; stdout?: string; stderr?: string }
		return {
			exitCode: result.code ?? 1,
			stdout: result.stdout ?? '',
			stderr: result.stderr ?? '',
			timedOut: false,
			durationMs: 0,
		}
	}
}
async function collect(source: AsyncIterable<SandboxFileEntry>) {
	const entries: SandboxFileEntry[] = []
	for await (const entry of source) entries.push(entry)
	return entries.sort((a, b) => a.path.localeCompare(b.path))
}
async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-walk-program-')))
	dirs.push(root)
	for (const name of [
		'top.ts',
		'.env',
		'.secret.ts',
		'é.ts',
		'é/one.ts',
		'.config/a.json',
		'.config/.secret.ts',
		'src/a.ts',
		'src/.secret.ts',
		'src/b.js',
		'src/deep/c.ts',
		'a/b/x',
		'c/x',
		...(process.platform === 'win32' ? [] : ['new\nline\t😀.ts', 'new\nfolder/deep.ts']),
	]) {
		await mkdir(dirname(join(root, name)), { recursive: true })
		await writeFile(join(root, name), name)
	}
	return root
}

describe.skipIf(process.platform === 'win32')('the actual POSIX guest file-walk program', () => {
	it.each([
		{ pattern: '*' },
		{ pattern: '*.ts' },
		{ pattern: '**/*.ts' },
		{ pattern: 'src/*.{ts,js}' },
		{ pattern: '.env' },
		{ pattern: '.config/*.json' },
		{ pattern: '{.config,src}/*.{json,ts}' },
		{ pattern: '{a/b,c}/x' },
		{ pattern: '**/*', includeHidden: true, maxDepth: 1 },
		{ pattern: '**/*', maxEntries: 2 },
		{ pattern: '!(skip)' },
		{ pattern: '{*.ts,*.js}' },
		{ pattern: '@(*.ts|*.js)' },
		{ pattern: '[^a]env' },
		{ pattern: '{.env,*}' },
		{ pattern: '{,foo}*.ts' },
		{ pattern: '[.]env' },
		{ pattern: '[.]config/*.json' },
		{ pattern: '@(.config|src)/*.json' },
		{ pattern: '**/{*.ts,*.js}' },
		{ pattern: '**/{*.ts,*.js}', includeHidden: true },
		{ pattern: '[[:alpha:]].ts' },
		{ pattern: '[[:alpha:]]/*.ts' },
		{ pattern: '{[[:alpha:]].ts,top.ts}' },
	])('matches local enumeration with $pattern', async (overrides) => {
		const root = await fixture()
		const options: SandboxWalkFilesOptions = { maxEntries: 30, ...overrides }
		const local = await collect(walkFilesLocally(root, options))
		const remote = await collect(walkFilesViaExec(exec, root, options))
		expect(remote).toEqual(local)
	})
	it.each(['*', '*.ts', '**.ts', '{*.ts,*.js}', '@(top|skip).ts'])(
		'never visits descendants of a single-segment %s in the actual guest',
		async (pattern) => {
			const root = await fixture()
			const options: SandboxWalkFilesOptions = {
				pattern,
				maxEntries: 30,
				maxVisitedEntries: (await readdir(root)).length,
			}
			const local = await collect(walkFilesLocally(root, options))
			const remote = await collect(walkFilesViaExec(exec, root, options))
			expect(local.length).toBeGreaterThan(0)
			expect(remote).toEqual(local)
		},
	)
	it('reports the traversal budget from the actual guest instead of claiming no matches', async () => {
		const root = await fixture()
		await expect(
			collect(
				walkFilesViaExec(exec, root, {
					pattern: '**/*.missing',
					maxEntries: 10,
					maxVisitedEntries: 1,
					failOnLimit: true,
				}),
			),
		).rejects.toMatchObject({ code: 'ERR_FILE_WALK_LIMIT' })
	})
	it('ends at the traversal bound with its entries and says so, unless asked to fail', async () => {
		const root = await fixture()
		let summary: SandboxWalkSummary | undefined
		const entries = await collect(
			walkFilesViaExec(exec, root, {
				pattern: '**/*',
				maxEntries: 100,
				maxVisitedEntries: 4,
				onSummary: (value) => {
					summary = value
				},
			}),
		)
		expect(entries.length).toBeLessThanOrEqual(4)
		expect(summary).toMatchObject({ stopped: 'entry-limit' })
	})
})

async function ignoreFixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-walk-ignore-program-')))
	dirs.push(root)
	for (const [name, text] of Object.entries({
		'.git/HEAD': 'ref',
		'.git/info/exclude': 'excluded.ts\n',
		'.gitignore': 'dist/\n*.log\n!keep.log\n/root-only.ts\n',
		'.ignore': '!rescued.log\nprivate/\n',
		'src/a.ts': '',
		'src/excluded.ts': '',
		'src/debug.log': '',
		'src/keep.log': '',
		'src/rescued.log': '',
		'src/root-only.ts': '',
		'root-only.ts': '',
		'dist/a.js': '',
		'private/x.ts': '',
		'pkg/.gitignore': 'gen/\n!/gen.ts\n',
		'pkg/gen/a.ts': '',
		'pkg/gen.ts': '',
		'pkg/b.ts': '',
		'work/.git': 'gitdir: elsewhere',
		'work/.gitignore': 'tmp/\n',
		'work/tmp/a.ts': '',
		'work/c.ts': '',
		'.claude/worktrees/w/.git': 'gitdir: x',
		'.claude/worktrees/w/a.ts': '',
		'a space/é.ts': '',
	})) {
		await mkdir(dirname(join(root, name)), { recursive: true })
		await writeFile(join(root, name), text)
	}
	return root
}

describe.skipIf(process.platform === 'win32')('ignore rules in the actual guest program', () => {
	let home = ''
	const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME }
	beforeEach(async () => {
		// The guest reads no global exclude file; the host must have none to read.
		home = await realpath(await mkdtemp(join(tmpdir(), 'namzu-walk-home-')))
		dirs.push(home)
		process.env.HOME = home
		process.env.XDG_CONFIG_HOME = join(home, '.config')
	})
	afterEach(() => {
		process.env.HOME = saved.home
		if (saved.xdg === undefined) Reflect.deleteProperty(process.env, 'XDG_CONFIG_HOME')
		else process.env.XDG_CONFIG_HOME = saved.xdg
	})
	const cases: { name: string; options: Partial<SandboxWalkFilesOptions>; below?: string }[] = [
		{ name: 'from the repository root', options: { includeHidden: true } },
		{ name: 'without hidden files', options: {} },
		{
			name: 'with ignore rules switched off',
			options: { includeHidden: true, respectIgnore: false },
		},
		{
			name: 'from a directory inside the repository',
			options: { includeHidden: true },
			below: 'pkg',
		},
		{ name: 'from inside an ignored directory', options: { includeHidden: true }, below: 'dist' },
		{ name: 'through a static prefix', options: { pattern: 'pkg/**/*.ts', includeHidden: true } },
		{ name: 'through a static prefix that is ignored', options: { pattern: 'dist/**/*.js' } },
	]
	it.each(cases)(
		"yields the host walk's files and summary $name",
		async ({ name: _name, options, below }) => {
			const base = await ignoreFixture()
			const root = below ? join(base, below) : base
			const walkOptions: SandboxWalkFilesOptions = { pattern: '**/*', maxEntries: 100, ...options }
			let hostSummary: SandboxWalkSummary | undefined
			let guestSummary: SandboxWalkSummary | undefined
			const local = await collect(
				walkFilesLocally(root, {
					...walkOptions,
					onSummary: (value) => {
						hostSummary = value
					},
				}),
			)
			const remote = await collect(
				walkFilesViaExec(exec, root, {
					...walkOptions,
					onSummary: (value) => {
						guestSummary = value
					},
				}),
			)
			expect(remote).toEqual(local)
			expect(guestSummary).toEqual(hostSummary)
			expect(local.length).toBeGreaterThan(0)
		},
	)
	it('applies the rules a repository holds, in the guest', async () => {
		const root = await ignoreFixture()
		const names = (
			await collect(walkFilesViaExec(exec, root, { maxEntries: 100, includeHidden: true }))
		)
			.map((entry) => entry.path.slice(root.length + 1))
			.sort()
		expect(names).toEqual([
			'.claude/worktrees/w/a.ts',
			'.gitignore',
			'.ignore',
			'a space/é.ts',
			'pkg/.gitignore',
			'pkg/b.ts',
			'pkg/gen.ts',
			'src/a.ts',
			'src/keep.log',
			'src/rescued.log',
			'src/root-only.ts',
			'work/.gitignore',
			'work/c.ts',
		])
	})
})
