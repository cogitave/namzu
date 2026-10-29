/**
 * A delegated checkout is kept only when the child changed something. That
 * decision rests on two facts the driver reports from a real repository: the
 * working tree is dirty, or HEAD left the commit the checkout started on. The
 * branch of a checkout that never moved goes with it; one that moved is never
 * deleted by a dispose.
 */

import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitWorktreeDriver } from '../git-worktree.js'

const logger = {
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	child() {
		return logger
	},
}

let root: string
let repo: string
let driver: GitWorktreeDriver

const git = (cwd: string, ...args: string[]) =>
	execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
	}).trim()

beforeEach(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-moved-')))
	repo = join(root, 'repo')
	execFileSync('git', ['init', '-q', repo])
	git(repo, 'config', 'user.email', 'a@example.test')
	git(repo, 'config', 'user.name', 'a')
	await writeFile(join(repo, 'a.txt'), 'a\n')
	git(repo, 'add', 'a.txt')
	git(repo, 'commit', '-q', '-m', 'first')
	driver = new GitWorktreeDriver({ repoRoot: repo, worktreesDir: join(root, 'wt'), logger })
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

const branches = () => git(repo, 'branch', '--list', 'namzu/*')

describe('a worktree that reports whether it moved', () => {
	it('reads clean and unmoved right after it is made, and disposing it removes its branch', async () => {
		const ref = await driver.create({ label: 'idle' })
		expect(ref.meta.baseCommit).toBe(git(repo, 'rev-parse', 'HEAD'))
		expect(await driver.inspect(ref)).toMatchObject({
			exists: true,
			isDirty: false,
			hasNewCommits: false,
		})
		await driver.dispose(ref)
		expect(branches()).toBe('')
	})

	it('keeps a branch that advances after the checkout was inspected', async () => {
		const ref = await driver.create({ label: 'raced' })
		const branch = `refs/heads/${ref.meta.branch}`
		let advanced = ''
		const racing = new GitWorktreeDriver({
			repoRoot: repo,
			worktreesDir: join(root, 'wt'),
			logger,
			execFile: async (file, args) => {
				const stdout = execFileSync(file, [...args], { encoding: 'utf8', stdio: 'pipe' })
				if (args.includes('worktree') && args.includes('remove')) {
					// Advance the branch after the stale listing, before deletion.
					const original = git(repo, 'rev-parse', branch)
					const tree = git(repo, 'rev-parse', `${original}^{tree}`)
					advanced = git(repo, 'commit-tree', tree, '-p', original, '-m', 'concurrent work')
					git(repo, 'update-ref', branch, advanced, original)
				}
				return { stdout, stderr: '' }
			},
		})
		await racing.dispose(ref)
		expect(advanced).not.toBe('')
		expect(git(repo, 'rev-parse', branch)).toBe(advanced)
	})

	it('reads dirty after an uncommitted edit', async () => {
		const ref = await driver.create({ label: 'edit' })
		await writeFile(join(ref.meta.worktreePath, 'b.txt'), 'b\n')
		expect(await driver.inspect(ref)).toMatchObject({ isDirty: true, hasNewCommits: false })
	})

	it('reads moved after a commit, and disposing it keeps the branch that holds the work', async () => {
		const ref = await driver.create({ label: 'commit' })
		const at = ref.meta.worktreePath
		await writeFile(join(at, 'b.txt'), 'b\n')
		git(at, 'add', 'b.txt')
		git(at, '-c', 'user.email=a@example.test', '-c', 'user.name=a', 'commit', '-q', '-m', 'work')
		expect(await driver.inspect(ref)).toMatchObject({ isDirty: false, hasNewCommits: true })
		await driver.dispose(ref)
		expect(branches()).toContain('namzu/commit')
	})

	it('treats a ref that recorded no starting commit as moved', async () => {
		const ref = await driver.create({ label: 'old' })
		const { baseCommit: _gone, ...meta } = ref.meta
		expect(await driver.inspect({ ...ref, meta })).toMatchObject({ hasNewCommits: true })
	})
})
