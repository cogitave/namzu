import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import type { SandboxWalkFilesOptions, SandboxWalkSummary } from '../../types/sandbox/index.js'
import { walkFilesLocally } from '../file-walk.js'

const dirs: string[] = []
let scratchHome = ''
const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME }
beforeEach(async () => {
	// A global git ignore file on the machine running the tests must not matter.
	scratchHome = await realpath(await mkdtemp(join(tmpdir(), 'namzu-ignore-home-')))
	dirs.push(scratchHome)
	process.env.HOME = scratchHome
	process.env.XDG_CONFIG_HOME = join(scratchHome, '.config')
})
afterEach(async () => {
	process.env.HOME = saved.home
	if (saved.xdg === undefined) Reflect.deleteProperty(process.env, 'XDG_CONFIG_HOME')
	else process.env.XDG_CONFIG_HOME = saved.xdg
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function tree(files: Record<string, string>): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-walk-ignore-')))
	dirs.push(root)
	for (const [name, text] of Object.entries(files)) {
		const target = join(root, name)
		await mkdir(dirname(target), { recursive: true })
		await writeFile(target, text)
	}
	return root
}

async function walk(root: string, options: Partial<SandboxWalkFilesOptions> = {}) {
	let summary: SandboxWalkSummary | undefined
	const found: string[] = []
	for await (const entry of walkFilesLocally(root, {
		pattern: '**/*',
		maxEntries: 100_000,
		includeHidden: true,
		onSummary: (value) => {
			summary = value
		},
		...options,
	}))
		found.push(relative(root, entry.path).split('\\').join('/'))
	return { found: found.sort(), summary: summary as SandboxWalkSummary | undefined }
}

describe('walking with ignore rules', () => {
	it('skips what .gitignore excludes inside a repository, and never enters version-control directories', async () => {
		const root = await tree({
			'.git/HEAD': 'ref',
			'.gitignore': 'dist/\n*.log\n',
			'src/a.ts': '',
			'dist/a.js': '',
			'src/debug.log': '',
		})
		const { found, summary } = await walk(root)
		expect(found).toEqual(['.gitignore', 'src/a.ts'])
		expect(summary?.ignoredDirectories).toBe(1)
	})

	it('ignores a .gitignore outside a repository but still honours .ignore', async () => {
		const root = await tree({ '.gitignore': 'a.ts\n', '.ignore': 'b.ts\n', 'a.ts': '', 'b.ts': '' })
		expect((await walk(root)).found).toEqual(['.gitignore', '.ignore', 'a.ts'])
	})

	it('lets a deeper file beat a shallower one, with negation', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': '*.gen.ts\n',
			'pkg/.gitignore': '!keep.gen.ts\n',
			'a.gen.ts': '',
			'pkg/keep.gen.ts': '',
			'pkg/drop.gen.ts': '',
		})
		expect((await walk(root)).found.filter((name) => name.endsWith('.gen.ts'))).toEqual([
			'pkg/keep.gen.ts',
		])
	})

	it('lets .ignore beat .gitignore in the same directory', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': 'a.ts\n',
			'.ignore': '!a.ts\nb.ts\n',
			'a.ts': '',
			'b.ts': '',
		})
		expect((await walk(root)).found.filter((name) => name.endsWith('.ts'))).toEqual(['a.ts'])
	})

	it('reads .git/info/exclude', async () => {
		const root = await tree({ '.git/info/exclude': 'secret.ts\n', 'secret.ts': '', 'open.ts': '' })
		expect((await walk(root)).found).toEqual(['open.ts'])
	})

	it('reads the global exclude file on the host', async () => {
		const root = await tree({ '.git/HEAD': '', 'scratch.ts': '', 'open.ts': '' })
		await mkdir(join(scratchHome, '.config', 'git'), { recursive: true })
		await writeFile(join(scratchHome, '.config', 'git', 'ignore'), 'scratch.ts\n')
		expect((await walk(root)).found).toEqual(['open.ts'])
	})

	it('applies the rules of every ancestor up to the repository root', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': 'dist/\n',
			'packages/a/dist/x.js': '',
			'packages/a/src/y.ts': '',
		})
		expect((await walk(join(root, 'packages', 'a'))).found).toEqual(['src/y.ts'])
	})

	it('never ignores the root it was asked to search', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': 'dist/\n',
			'dist/x.js': '',
			'dist/deep/y.js': '',
		})
		expect((await walk(join(root, 'dist'))).found).toEqual(['deep/y.js', 'x.js'])
	})

	it('starts a pattern inside an ignored directory when the pattern names it', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': 'dist/\n',
			'dist/x.js': '',
			'src/y.js': '',
		})
		expect((await walk(root, { pattern: 'dist/**/*.js' })).found).toEqual(['dist/x.js'])
		expect((await walk(root, { pattern: '**/*.js' })).found).toEqual(['src/y.js'])
	})

	it('walks ignored trees when respectIgnore is false', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': 'dist/\n',
			'dist/x.js': '',
			'src/y.js': '',
		})
		const { found } = await walk(root, { respectIgnore: false })
		expect(found).toEqual(['.gitignore', 'dist/x.js', 'src/y.js'])
	})

	it('lets a nested repository apply its own .gitignore when the root is above every repository', async () => {
		const parent = await tree({
			'project/.git/HEAD': '',
			'project/.gitignore': 'build/\n',
			'project/build/a.js': '',
			'project/src/b.js': '',
			'notes/c.md': '',
		})
		expect((await walk(parent)).found).toEqual([
			'notes/c.md',
			'project/.gitignore',
			'project/src/b.js',
		])
	})

	it('treats a nested checkout marked by a .git file as a boundary of its own', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': 'logs/\n',
			'work/.git': 'gitdir: elsewhere',
			'work/.gitignore': 'tmp/\n',
			'work/tmp/a.ts': '',
			'work/logs/b.ts': '',
			'work/src/c.ts': '',
		})
		expect((await walk(root)).found).toEqual(['.gitignore', 'work/.gitignore', 'work/src/c.ts'])
	})

	it('prunes a nested checkout the parent rules exclude', async () => {
		const root = await tree({
			'.git/HEAD': '',
			'.gitignore': '.claude/worktrees/\n',
			'.claude/worktrees/w1/.git': 'gitdir: x',
			'.claude/worktrees/w1/src/a.ts': '',
			'src/b.ts': '',
		})
		const { found, summary } = await walk(root)
		expect(found).toEqual(['.gitignore', 'src/b.ts'])
		expect(summary?.visited).toBeLessThan(12)
	})
})

describe('the examined-entry bound', () => {
	it('ends the walk with the entries found so far and says so', async () => {
		const root = await tree(
			Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, ''])),
		)
		const { found, summary } = await walk(root, { maxVisitedEntries: 10 })
		expect(found).toHaveLength(10)
		expect(summary).toMatchObject({ stopped: 'entry-limit' })
	})

	it('reports a complete walk without a stop reason', async () => {
		const root = await tree({ 'a.ts': '' })
		expect((await walk(root)).summary?.stopped).toBeUndefined()
	})

	it('still throws when the caller asks for the old behaviour', async () => {
		const root = await tree(
			Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, ''])),
		)
		await expect(walk(root, { maxVisitedEntries: 10, failOnLimit: true })).rejects.toMatchObject({
			code: 'ERR_FILE_WALK_LIMIT',
		})
	})
})
