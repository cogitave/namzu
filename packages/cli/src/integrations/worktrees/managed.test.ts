import { execFileSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	loadResumableConversation,
	openSessions,
	startConversation,
} from '../sessions/store.js'
import { openManagedWorktrees } from './managed.js'

const dirs: string[] = []

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

function fixture(): { repo: string; stateRoot: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-managed-worktrees-'))
	dirs.push(root)
	const repo = join(root, 'repo')
	const stateRoot = join(root, 'state')
	mkdirSync(repo)
	mkdirSync(stateRoot)
	git(repo, 'init', '-q')
	writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
	git(repo, 'add', 'tracked.txt')
	git(
		repo,
		'-c',
		'user.name=Namzu Test',
		'-c',
		'user.email=test@example.com',
		'commit',
		'-qm',
		'initial',
	)
	return { repo, stateRoot }
}

afterEach(() => {
	for (const root of dirs.splice(0)) removeTempDir(root)
})

describe('CLI managed Git worktrees', () => {
	it('creates at committed HEAD while preserving dirty source files, then lists from both checkouts', async () => {
		const { repo, stateRoot } = fixture()
		writeFileSync(join(repo, 'tracked.txt'), 'dirty source\n')
		writeFileSync(join(repo, 'untracked.txt'), 'keep me\n')
		const manager = await openManagedWorktrees(repo, { stateRoot })
		const created = await manager.create('task-one')
		expect(created.sourceDirty).toBe(true)
		expect(created.branch).toBe('namzu/task-one')
		expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('dirty source\n')
		expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('keep me\n')
		expect(readFileSync(join(created.path, 'tracked.txt'), 'utf8')).toBe('committed\n')
		expect(existsSync(join(created.path, 'untracked.txt'))).toBe(false)
		expect(await manager.list()).toEqual([
			{
				label: 'task-one',
				path: created.path,
				branch: created.branch,
				dirty: false,
			},
		])
		const fromChild = await openManagedWorktrees(created.path, { stateRoot })
		expect(fromChild.repoRoot).toBe(repo)
		expect(await fromChild.list()).toEqual(await manager.list())
		const second = await fromChild.create('task-two')
		expect(git(second.path, 'rev-parse', 'HEAD')).toBe(git(created.path, 'rev-parse', 'HEAD'))
		writeFileSync(join(created.path, 'tracked.txt'), 'still working\n')
		expect(await manager.inspect('task-one')).toMatchObject({ dirty: true })
		expect(readFileSync(join(created.path, 'tracked.txt'), 'utf8')).toBe('still working\n')
	})

	it('refuses collisions and foreign or symlinked worktrees without changing either checkout', async () => {
		const { repo, stateRoot } = fixture()
		const manager = await openManagedWorktrees(repo, { stateRoot })
		const owned = await manager.create('owned')
		await expect(manager.create('owned')).rejects.toThrow()
		expect(await manager.inspect('owned')).toMatchObject({ path: owned.path })
		const foreign = join(manager.worktreesDir, 'foreign')
		git(repo, 'worktree', 'add', '-qb', 'foreign-branch', foreign)
		expect(await manager.inspect('foreign')).toBeNull()
		expect((await manager.list()).map((item) => item.label)).toEqual(['owned'])
		const outside = join(stateRoot, 'outside')
		mkdirSync(outside)
		symlinkSync(outside, join(manager.worktreesDir, 'escape'), 'dir')
		await expect(manager.inspect('escape')).rejects.toThrow(/ownership|directory/i)
		expect(existsSync(outside)).toBe(true)
		await expect(manager.create('../outside')).rejects.toThrow(/name/i)
	})

	it('serializes two creators of the same label', async () => {
		const { repo, stateRoot } = fixture()
		const manager = await openManagedWorktrees(repo, { stateRoot })
		const attempts = await Promise.allSettled([manager.create('shared'), manager.create('shared')])
		expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1)
		expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1)
		expect((await manager.list()).map((item) => item.label)).toEqual(['shared'])
	})

	it('forks a settled conversation into the new Project and resumes only its own history', async () => {
		const { repo, stateRoot } = fixture()
		const source = await openSessions(repo, { stateRoot })
		const id = await startConversation(source)
		await recordTurn(source, id, [createUserMessage('Inspect the build')])
		const manager = await openManagedWorktrees(repo, { stateRoot })
		const forked = await manager.fork(id, 'investigation')
		const target = await openSessions(forked.path, { stateRoot })
		try {
			expect(target.projectId).not.toBe(source.projectId)
			expect(forked.copied).toBe(1)
			expect(
				(await loadResumableConversation(target, forked.conversationId)).map((m) => m.content),
			).toEqual(['Inspect the build'])
			expect((await loadResumableConversation(source, id)).map((m) => m.content)).toEqual([
				'Inspect the build',
			])
			expect(await manager.resume('investigation')).toMatchObject({
				worktree: { path: forked.path },
				conversationId: forked.conversationId,
			})
			await expect(manager.resume('investigation', id)).rejects.toThrow(
				/does not belong|not found/i,
			)
		} finally {
			closeSessions(target)
			closeSessions(source)
		}
	})

	it('fails before creating a worktree for a missing or empty source conversation', async () => {
		const { repo, stateRoot } = fixture()
		const manager = await openManagedWorktrees(repo, { stateRoot })
		await expect(
			manager.fork(asSessionId('01990000-0000-7000-8000-000000000000'), 'missing'),
		).rejects.toThrow()
		const source = await openSessions(repo, { stateRoot })
		const empty = await startConversation(source)
		await expect(manager.fork(empty, 'empty')).rejects.toThrow(/no messages/i)
		expect(await manager.list()).toEqual([])
		closeSessions(source)
	})

	it('names the branch with the chosen prefix and still finds worktrees made under another', async () => {
		const { repo, stateRoot } = fixture()
		const before = await openManagedWorktrees(repo, { stateRoot, settings: {} })
		const old = await before.create('first')
		expect(old.branch).toBe('namzu/first')
		const after = await openManagedWorktrees(repo, { stateRoot, settings: { branchPrefix: 'ada' } })
		const made = await after.create('second')
		expect(made.branch).toBe('ada/second')
		expect(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ada/second')
		expect((await after.list()).map((w) => `${w.label}:${w.branch}`)).toEqual([
			'first:namzu/first',
			'second:ada/second',
		])
	})

	it('makes the next worktree in the chosen folder, one folder per project', async () => {
		const { repo, stateRoot } = fixture()
		const chosen = mkdtempSync(join(tmpdir(), 'namzu-worktree-place-'))
		dirs.push(chosen)
		const manager = await openManagedWorktrees(repo, { stateRoot, settings: { location: chosen } })
		const created = await manager.create('here')
		expect(created.path.startsWith(realpathSync(chosen))).toBe(true)
		expect(existsSync(join(created.path, 'tracked.txt'))).toBe(true)
		expect(await manager.list()).toHaveLength(1)
	})

	it('refuses a chosen folder that is gone, saying why', async () => {
		const { repo, stateRoot } = fixture()
		const missing = join(stateRoot, 'nowhere')
		await expect(
			openManagedWorktrees(repo, { stateRoot, settings: { location: missing } }),
		).rejects.toThrow(/does not exist/)
	})

	it('holds only the chosen folders in a new worktree', async () => {
		const { repo, stateRoot } = fixture()
		mkdirSync(join(repo, 'keep'))
		mkdirSync(join(repo, 'leave'))
		writeFileSync(join(repo, 'keep', 'a.txt'), 'a\n')
		writeFileSync(join(repo, 'leave', 'b.txt'), 'b\n')
		git(repo, 'add', 'keep', 'leave')
		git(
			repo,
			'-c',
			'user.name=Namzu Test',
			'-c',
			'user.email=test@example.com',
			'commit',
			'-qm',
			'more',
		)
		const manager = await openManagedWorktrees(repo, {
			stateRoot,
			settings: { sparseFolders: ['./keep/'] },
		})
		const created = await manager.create('narrow')
		expect(existsSync(join(created.path, 'keep', 'a.txt'))).toBe(true)
		expect(existsSync(join(created.path, 'tracked.txt'))).toBe(true)
		expect(existsSync(join(created.path, 'leave'))).toBe(false)
	})

	it('keeps a new worktree in full, and says so, when the sparse folders cannot be applied', async () => {
		const { repo, stateRoot } = fixture()
		const notices: string[] = []
		const manager = await openManagedWorktrees(repo, {
			stateRoot,
			settings: { sparseFolders: ['../outside'] },
			onNotice: (line) => notices.push(line),
		})
		const created = await manager.create('whole')
		expect(existsSync(join(created.path, 'tracked.txt'))).toBe(true)
		expect(notices).toHaveLength(1)
		expect(notices[0]).toContain('kept in full')
		await expect(manager.create('whole')).rejects.toThrow('already exists')
	})
})
