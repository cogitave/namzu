import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
	COMMIT_DIFF_CAP,
	type CommitFile,
	cleanCommitMessage,
	createProjectCommit,
	normalizeCommitPaths,
	parseStatus,
	plainCommitMessage,
} from '../desktop-commit.js'

/** A throwaway repository with its own identity: the person's own git settings are never read or written. */
function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-commit-'))
	const git = (...args: string[]) =>
		execFileSync('git', args, {
			cwd: dir,
			stdio: 'pipe',
			env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
		})
	git('init', '-q', '-b', 'trunk')
	git('config', 'user.name', 'Fixture')
	git('config', 'user.email', 'fixture@example.invalid')
	git('config', 'commit.gpgsign', 'false')
	writeFileSync(join(dir, 'a.txt'), 'one\n')
	writeFileSync(join(dir, 'b.txt'), 'one\n')
	git('add', '.')
	git('commit', '-q', '-m', 'Start')
	return dir
}
const git = (dir: string, ...args: string[]) =>
	execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
	})

const trusted = () => true

describe('which paths the window may name', () => {
	const cwd = '/work/demo'
	it('keeps paths inside the folder, as project-relative POSIX paths, once each', () => {
		expect(
			normalizeCommitPaths(cwd, ['a.txt', '/work/demo/src/b.ts', './a.txt', 'src//c.ts']),
		).toEqual(['a.txt', 'src/b.ts', 'src/c.ts'])
	})
	it('drops what leads out, what starts with a dash, git’s own folder and what is not a path', () => {
		expect(
			normalizeCommitPaths(cwd, [
				'../x',
				'a/../../x',
				'/etc/passwd',
				'/work/demo/../other/x',
				'-rf',
				'--amend',
				'.git/config',
				'.git',
				'',
				'a\0b',
				7,
				null,
			]),
		).toEqual([])
	})
})

describe('reading git’s status', () => {
	it('reads each change and skips the old name of a rename', () => {
		const out = ' M a.txt\0A  new.txt\0?? loose.txt\0 D gone.txt\0R  to.txt\0from.txt\0'
		expect(parseStatus(out)).toEqual([
			{ path: 'a.txt', state: 'modified', untracked: false },
			{ path: 'new.txt', state: 'added', untracked: false },
			{ path: 'loose.txt', state: 'added', untracked: true },
			{ path: 'gone.txt', state: 'deleted', untracked: false },
			{ path: 'to.txt', state: 'renamed', untracked: false },
		])
	})
})

describe('the message', () => {
	it('is plain and deterministic when no model answers', () => {
		const file = (path: string, state: CommitFile['state'] = 'modified') => ({ path, state })
		expect(plainCommitMessage([])).toBe('Update files')
		expect(plainCommitMessage([file('src/a.ts')])).toBe('Update a.ts')
		expect(plainCommitMessage([file('a.ts', 'added'), file('b.ts', 'added')])).toBe(
			'Add a.ts, b.ts',
		)
		expect(plainCommitMessage([file('a.ts', 'deleted')])).toBe('Remove a.ts')
		expect(plainCommitMessage(['a', 'b', 'c', 'd'].map((n) => file(n)))).toBe('Update 4 files')
	})
	it('cleans a model’s reply', () => {
		expect(cleanCommitMessage(undefined)).toBeUndefined()
		expect(cleanCommitMessage('   ')).toBeUndefined()
		expect(cleanCommitMessage('```\nFix the parser\n```')).toBe('Fix the parser')
		expect(cleanCommitMessage('"Fix the parser"\u0007')).toBe('Fix the parser')
		expect(cleanCommitMessage('x'.repeat(9000))?.length).toBe(4000)
	})
})

describe('the preview', () => {
	it('lists only the files the conversation changed that git still sees changed, and counts the rest', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		writeFileSync(join(dir, 'b.txt'), 'by hand\n')
		writeFileSync(join(dir, 'new.txt'), 'fresh\n')
		const commit = createProjectCommit({ isTrusted: trusted })
		const preview = await commit.preview(dir, [
			'a.txt',
			'new.txt',
			'clean-but-named.txt',
			'../escape',
		])
		expect(preview.files.map((f) => `${f.state}:${f.path}`).sort()).toEqual([
			'added:new.txt',
			'modified:a.txt',
		])
		expect(preview.otherDirty).toBe(1)
		expect(preview.branch).toBe('trunk')
		expect(preview.detached).toBe(false)
		expect(preview.blocker).toBeUndefined()
		expect(preview.suggestedMessage).toBe('Update a.txt, new.txt')
		expect(preview.messageSource).toBe('plain')
	})

	it('leaves files that look like secrets out of the list and out of the message request', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		writeFileSync(join(dir, '.env'), 'TOKEN=hunter2\n')
		writeFileSync(join(dir, 'server.pem'), 'PRIVATE\n')
		const suggest = vi.fn(
			async (_request: unknown, _signal?: AbortSignal, _session?: string) => 'Add two lines',
		)
		const commit = createProjectCommit({ isTrusted: trusted, suggest })
		const preview = await commit.preview(dir, ['a.txt', '.env', 'server.pem'], 's1')
		expect(preview.files.map((f) => f.path)).toEqual(['a.txt'])
		expect(preview.skippedSecrets).toBe(2)
		expect(preview.suggestedMessage).toBe('Add two lines')
		expect(preview.messageSource).toBe('model')
		const sent = JSON.stringify(suggest.mock.calls[0]?.[0])
		expect(sent).toContain('a.txt')
		expect(sent).not.toContain('hunter2')
		expect(sent).not.toContain('PRIVATE')
		expect(sent).not.toContain('.env')
		expect(suggest.mock.calls[0]?.[2]).toBe('s1')
	})

	it('caps what the model is shown', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), `${'line\n'.repeat(5000)}`)
		const suggest = vi.fn(async (_request: { diff: string }) => 'Grow a')
		await createProjectCommit({ isTrusted: trusted, suggest }).preview(dir, ['a.txt'])
		expect(suggest.mock.calls[0]?.[0].diff.length).toBeLessThanOrEqual(COMMIT_DIFF_CAP)
	})

	it('falls back to the plain message when the model fails, answers nothing or is slow to fail', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		for (const suggest of [
			async () => {
				throw new Error('offline')
			},
			async () => undefined,
			async () => '   ',
		]) {
			const preview = await createProjectCommit({ isTrusted: trusted, suggest }).preview(dir, [
				'a.txt',
			])
			expect(preview).toMatchObject({ suggestedMessage: 'Update a.txt', messageSource: 'plain' })
		}
	})

	it('asks the model only when there is something to commit', async () => {
		const dir = repo()
		const suggest = vi.fn(async () => 'x')
		const preview = await createProjectCommit({ isTrusted: trusted, suggest }).preview(dir, [
			'a.txt',
		])
		expect(suggest).not.toHaveBeenCalled()
		expect(preview.blocker).toBe('Nothing to commit from this conversation.')
	})

	it('refuses an untrusted folder without running git, and says a folder that is no repository is none', async () => {
		const run = vi.fn()
		const untrusted = await createProjectCommit({ isTrusted: () => false, git: run }).preview(
			'/x',
			['a'],
		)
		expect(untrusted.blocker).toBe('Trust this folder to commit in it.')
		expect(run).not.toHaveBeenCalled()
		const plain = mkdtempSync(join(tmpdir(), 'namzu-nogit-'))
		const none = await createProjectCommit({ isTrusted: trusted }).preview(plain, ['a'])
		expect(none.blocker).toBe('Commit needs a Git repository.')
	})

	it('names a merge in progress as the reason, and a detached head as such', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		writeFileSync(join(dir, '.git', 'MERGE_HEAD'), `${git(dir, 'rev-parse', 'HEAD')}`)
		const merging = await createProjectCommit({ isTrusted: trusted }).preview(dir, ['a.txt'])
		expect(merging.blocker).toMatch(/merge, rebase, cherry-pick or revert is in progress/)
		execFileSync('rm', [join(dir, '.git', 'MERGE_HEAD')])
		git(dir, 'checkout', '-q', '--detach')
		const detached = await createProjectCommit({ isTrusted: trusted }).preview(dir, ['a.txt'])
		expect(detached).toMatchObject({ detached: true, branch: null })
	})
})

describe('the commit', () => {
	it('commits only the confirmed files with the message as written, leaving other changes dirty', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		writeFileSync(join(dir, 'b.txt'), 'by hand\n')
		writeFileSync(join(dir, 'new.txt'), 'fresh\n')
		const commit = createProjectCommit({ isTrusted: trusted })
		const preview = await commit.preview(dir, ['a.txt', 'new.txt'])
		const before = git(dir, 'config', '--list', '--local')
		const result = await commit.commit(dir, {
			paths: ['a.txt', 'new.txt'],
			message: '  Add the second line  ',
			fingerprints: Object.fromEntries(preview.files.map((f) => [f.path, f.fingerprint])),
		})
		expect(result.subject).toBe('Add the second line')
		expect(git(dir, 'log', '-1', '--format=%s').trim()).toBe('Add the second line')
		expect(
			git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(),
		).toEqual(['a.txt', 'new.txt'])
		expect(git(dir, 'status', '--porcelain').trim()).toBe('M b.txt')
		// Nothing about the repository's settings changed, and there is nowhere it could have pushed to.
		expect(git(dir, 'config', '--list', '--local')).toBe(before)
		expect(git(dir, 'remote')).toBe('')
	})

	it('lets the repository’s own hooks run, shows what a failing one said, and commits nothing', async () => {
		const dir = repo()
		const hook = join(dir, '.git', 'hooks', 'pre-commit')
		mkdirSync(join(dir, '.git', 'hooks'), { recursive: true })
		writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n')
		chmodSync(hook, 0o755)
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		const commit = createProjectCommit({ isTrusted: trusted })
		const preview = await commit.preview(dir, ['a.txt'])
		await expect(
			commit.commit(dir, {
				paths: ['a.txt'],
				message: 'Try',
				fingerprints: { 'a.txt': preview.files[0]?.fingerprint },
			}),
		).rejects.toThrow(/hook says no/)
		expect(git(dir, 'log', '--format=%s').trim()).toBe('Start')
	})

	it('refuses a file that changed after the preview, and one with no changes left', async () => {
		const dir = repo()
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		const commit = createProjectCommit({ isTrusted: trusted })
		const preview = await commit.preview(dir, ['a.txt'])
		const fingerprints = { 'a.txt': preview.files[0]?.fingerprint }
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
		await expect(
			commit.commit(dir, { paths: ['a.txt'], message: 'x', fingerprints }),
		).rejects.toThrow(/changed since you looked/)
		await expect(
			commit.commit(dir, { paths: ['b.txt'], message: 'x', fingerprints: {} }),
		).rejects.toThrow(/no longer has changes/)
		expect(git(dir, 'log', '--format=%s').trim()).toBe('Start')
	})

	it('refuses an empty message, no files, a secret file, a path that leads out, and an untrusted folder', async () => {
		const dir = repo()
		writeFileSync(join(dir, '.env'), 'T=1\n')
		const commit = createProjectCommit({ isTrusted: trusted })
		await expect(
			commit.commit(dir, { paths: ['a.txt'], message: '  ', fingerprints: {} }),
		).rejects.toThrow(/message/)
		await expect(commit.commit(dir, { paths: [], message: 'x', fingerprints: {} })).rejects.toThrow(
			/at least one file/,
		)
		await expect(
			commit.commit(dir, { paths: ['../x'], message: 'x', fingerprints: {} }),
		).rejects.toThrow(/at least one file/)
		await expect(
			commit.commit(dir, { paths: ['.env'], message: 'x', fingerprints: {} }),
		).rejects.toThrow(/secret/)
		await expect(
			createProjectCommit({ isTrusted: () => false }).commit(dir, {
				paths: ['a.txt'],
				message: 'x',
				fingerprints: {},
			}),
		).rejects.toThrow(/Trust this folder/)
	})

	it('shows git’s own words when there is no identity, and never sets one', async () => {
		const dir = repo()
		git(dir, 'config', '--unset', 'user.name')
		git(dir, 'config', '--unset', 'user.email')
		writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
		const env = {
			...process.env,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_AUTHOR_NAME: '',
			GIT_COMMITTER_NAME: '',
			EMAIL: '',
		}
		const exec = (args: readonly string[], cwd: string) =>
			new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
				try {
					const stdout = execFileSync('git', [...args], {
						cwd,
						env,
						encoding: 'utf8',
						stdio: 'pipe',
					})
					resolve({ stdout, stderr: '' })
				} catch (error) {
					const failure = new Error('git failed') as Error & { output?: string }
					failure.output = String((error as { stderr?: Buffer }).stderr ?? '')
					reject(failure)
				}
			})
		const commit = createProjectCommit({ isTrusted: trusted, git: exec })
		const preview = await commit.preview(dir, ['a.txt'])
		await expect(
			commit.commit(dir, {
				paths: ['a.txt'],
				message: 'x',
				fingerprints: { 'a.txt': preview.files[0]?.fingerprint },
			}),
		).rejects.toThrow(/identity|tell me who you are|empty ident|Author identity unknown/i)
		expect(() => git(dir, 'config', 'user.name')).toThrow()
	})

	it('never runs the dangerous forms: the source has no add -A, no --no-verify and no push', () => {
		const source = readFileSync(new URL('../desktop-commit.ts', import.meta.url), 'utf8')
		for (const forbidden of [
			/'-A'/,
			/'--all'/,
			/--no-verify/,
			/'push'/,
			/'--amend'/,
			/'reset'/,
			/'checkout'/,
			/user\.(name|email)/,
		])
			expect(source).not.toMatch(forbidden)
	})
})
