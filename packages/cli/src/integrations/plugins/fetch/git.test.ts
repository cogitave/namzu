import { EventEmitter } from 'node:events'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { git, makeRepo } from '../../../__fixtures__/git-repo.js'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	type ChildLike,
	FetchError,
	GIT_OUTPUT_CAP,
	type GitRun,
	cloneRepository,
	createGitRunner,
	explainGitFailure,
	gitEnvironment,
	gitSettings,
	gitTimeoutMs,
} from './git.js'

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-git-fetch-'))
})
afterEach(() => removeTempDir(root))

const file = { allowFileProtocol: true } as const

async function failure(promise: Promise<unknown>): Promise<FetchError> {
	try {
		await promise
	} catch (error) {
		expect(error).toBeInstanceOf(FetchError)
		return error as FetchError
	}
	throw new Error('expected a FetchError')
}

describe('the git environment and settings', () => {
	it('removes every GIT_ variable and sets the safe ones', () => {
		const env = gitEnvironment(
			{
				PATH: '/bin',
				HOME: '/h',
				GIT_DIR: '/evil',
				GIT_WORK_TREE: '/evil',
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: 'core.hooksPath',
				GIT_SSH_COMMAND: 'evil',
				GIT_ASKPASS: '/bin/ask',
			},
			false,
		)
		expect(env.PATH).toBe('/bin')
		expect(env.HOME).toBe('/h')
		expect(env.GIT_DIR).toBeUndefined()
		expect(env.GIT_WORK_TREE).toBeUndefined()
		expect(env.GIT_CONFIG_COUNT).toBeUndefined()
		expect(env.GIT_TERMINAL_PROMPT).toBe('0')
		expect(env.GIT_ASKPASS).toBe('')
		expect(env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes -o StrictHostKeyChecking=yes')
		expect(env.GIT_ALLOW_PROTOCOL).toBe('https:ssh')
		expect(env.GIT_LFS_SKIP_SMUDGE).toBe('1')
		expect(gitEnvironment({}, true).GIT_ALLOW_PROTOCOL).toBe('https:ssh:file')
	})

	it('carries no hooks, no fsmonitor, no links, no ext, fsck on every object, file only for tests', () => {
		const settings = gitSettings(false, 'linux')
		const joined = settings.join(' ')
		expect(joined).toContain('core.hooksPath=/dev/null')
		expect(joined).toContain('core.fsmonitor=false')
		expect(joined).toContain('core.symlinks=false')
		expect(joined).toContain('protocol.ext.allow=never')
		expect(joined).toContain('protocol.file.allow=never')
		expect(joined).toContain('transfer.fsckObjects=true')
		expect(gitSettings(true, 'linux').join(' ')).toContain('protocol.file.allow=always')
		expect(gitSettings(false, 'win32').join(' ')).toContain('core.hooksPath=NUL')
		expect(settings.filter((_, i) => i % 2 === 0).every((flag) => flag === '-c')).toBe(true)
	})

	it('reads the timeout from the environment, clamped', () => {
		expect(gitTimeoutMs({})).toBe(120_000)
		expect(gitTimeoutMs({ NAMZU_PLUGIN_GIT_TIMEOUT_MS: '5000' })).toBe(5000)
		expect(gitTimeoutMs({ NAMZU_PLUGIN_GIT_TIMEOUT_MS: '9999999' })).toBe(600_000)
		for (const bad of ['0', '-1', 'abc', '1.5', '']) {
			expect(gitTimeoutMs({ NAMZU_PLUGIN_GIT_TIMEOUT_MS: bad }), bad).toBe(120_000)
		}
	})
})

class FakeChild extends EventEmitter {
	pid: number | undefined = 4242
	stdout = new EventEmitter()
	stderr = new EventEmitter()
	killed: string[] = []
	kill(signal?: string): boolean {
		this.killed.push(signal ?? 'SIGTERM')
		return true
	}
}

describe('the git runner', () => {
	it('kills the whole process group when the timeout passes, on a fake clock', async () => {
		vi.useFakeTimers()
		try {
			const child = new FakeChild()
			const killed: number[] = []
			let options: Record<string, unknown> = {}
			const runner = createGitRunner({
				spawn: (_command, _args, spawnOptions) => {
					options = spawnOptions as Record<string, unknown>
					return child as unknown as ChildLike
				},
				killTree: (pid) => killed.push(pid),
				platform: 'linux',
			})
			const pending = runner(['clone'], { env: {}, timeoutMs: 120_000 })
			await vi.advanceTimersByTimeAsync(119_999)
			expect(killed).toEqual([])
			await vi.advanceTimersByTimeAsync(1)
			const run = await pending
			expect(run.timedOut).toBe(true)
			expect(killed).toEqual([4242])
			// A group of its own (so the kill reaches children), no shell, no stdin.
			expect(options).toMatchObject({
				shell: false,
				detached: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			expect(explainGitFailure(run, 'https://example.com/x.git', 120_000)).toMatchObject({
				code: 69,
				kind: 'timeout',
			})
			expect(explainGitFailure(run, 'https://example.com/x.git', 120_000).message).toContain(
				'120 seconds',
			)
		} finally {
			vi.useRealTimers()
		}
	})

	it('asks for a tree kill on Windows and does not detach', async () => {
		vi.useFakeTimers()
		try {
			const child = new FakeChild()
			const killed: number[] = []
			let options: Record<string, unknown> = {}
			const runner = createGitRunner({
				spawn: (_c, _a, o) => {
					options = o as Record<string, unknown>
					return child as unknown as ChildLike
				},
				killTree: (pid) => killed.push(pid),
				platform: 'win32',
			})
			const pending = runner(['fetch'], { env: {}, timeoutMs: 10 })
			await vi.advanceTimersByTimeAsync(10)
			await pending
			expect(options.detached).toBe(false)
			expect(killed).toEqual([4242])
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not time out a run that finished, and keeps at most 1 MiB of output', async () => {
		vi.useFakeTimers()
		try {
			const child = new FakeChild()
			const killed: number[] = []
			const runner = createGitRunner({
				spawn: () => child as unknown as ChildLike,
				killTree: (pid) => killed.push(pid),
				platform: 'linux',
			})
			const pending = runner(['status'], { env: {}, timeoutMs: 1000 })
			child.stdout.emit('data', 'x'.repeat(GIT_OUTPUT_CAP))
			child.stdout.emit('data', 'y'.repeat(10))
			child.stderr.emit('data', 'warn')
			child.emit('close', 0)
			const run = await pending
			expect(run.code).toBe(0)
			expect(run.stdout).toHaveLength(GIT_OUTPUT_CAP)
			expect(run.stdout.endsWith('y')).toBe(false)
			expect(run.stderr).toBe('warn')
			await vi.advanceTimersByTimeAsync(5000)
			expect(killed).toEqual([])
			expect(run.timedOut).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it('reports a missing git program', async () => {
		const child = new FakeChild()
		const runner = createGitRunner({
			spawn: () => child as unknown as ChildLike,
			platform: 'linux',
		})
		const pending = runner(['status'], { env: {}, timeoutMs: 1000 })
		child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
		const run = await pending
		expect(run.missing).toBe(true)
		const error = explainGitFailure(run, 'https://example.com/x.git', 1000)
		expect(error.code).toBe(69)
		expect(error.message).toBe(
			'Git is needed for this address. Install Git and run the command again.',
		)
	})
})

describe('what git says, in plain words', () => {
	const run = (stderr: string): GitRun => ({
		code: 128,
		stdout: '',
		stderr,
		timedOut: false,
		missing: false,
	})
	it('maps the failures', () => {
		const url = 'https://example.com/x.git'
		const asked = explainGitFailure(
			run("fatal: could not read Username for 'https://example.com': terminal prompts disabled"),
			url,
			1000,
		)
		expect(asked.code).toBe(66)
		expect(asked.message).toContain('not found or not accessible')
		expect(asked.message).toContain('cannot ask for a password')
		expect(explainGitFailure(run('git@h: Permission denied (publickey).'), url, 1000).kind).toBe(
			'auth',
		)
		expect(explainGitFailure(run('remote: Repository not found.'), url, 1000)).toMatchObject({
			code: 66,
			kind: 'not-found',
		})
		expect(
			explainGitFailure(run('fatal: Remote branch nope not found in upstream origin'), url, 1000),
		).toMatchObject({
			code: 66,
			kind: 'ref',
		})
		expect(
			explainGitFailure(
				run(
					"fatal: unable to access 'https://example.com/x.git/': Could not resolve host: example.com",
				),
				url,
				1000,
			),
		).toMatchObject({
			code: 69,
			kind: 'network',
			message: 'Could not reach example.com.',
		})
		expect(explainGitFailure(run('error: object abc: fsck error'), url, 1000).kind).toBe('fsck')
		expect(explainGitFailure(run('fatal: something odd\n'), url, 1000)).toMatchObject({
			code: 1,
			kind: 'git',
		})
	})
})

describe('cloning a local bare repository (the test-only file option)', () => {
	it('clones the default branch shallowly, reports the commit, and keeps .git for a marketplace', async () => {
		const repo = makeRepo(root, 'm')
		const first = repo.commit({ 'a.txt': 'one' })
		const head = repo.commit({ 'a.txt': 'two' })
		const dest = join(root, 'out')
		const result = await cloneRepository({ url: repo.url, dest }, file)
		expect(result.commit).toBe(head)
		expect(result.commit).not.toBe(first)
		expect(readFileSync(join(dest, 'a.txt'), 'utf8')).toBe('two')
		expect(existsSync(join(dest, '.git'))).toBe(true)
		// Depth 1: the first commit is not there.
		expect(git(dest, 'rev-list', '--count', 'HEAD')).toBe('1')
		expect(result).toMatchObject({ lfsPointers: 0, submodules: 0 })
	})

	it('takes a branch or a tag with --branch, and says plainly when the ref is missing', async () => {
		const repo = makeRepo(root, 'm')
		const one = repo.commit({ 'v.txt': '1' })
		repo.tag('v1')
		repo.commit({ 'v.txt': '2' })
		repo.branch('dev')
		const tag = await cloneRepository({ url: repo.url, ref: 'v1', dest: join(root, 't') }, file)
		expect(tag.commit).toBe(one)
		const dev = await cloneRepository({ url: repo.url, ref: 'dev', dest: join(root, 'd') }, file)
		expect(readFileSync(join(root, 'd', 'v.txt'), 'utf8')).toBe('2')
		expect(dev.commit).not.toBe(one)
		const missing = await failure(
			cloneRepository({ url: repo.url, ref: 'nope', dest: join(root, 'x') }, file),
		)
		expect(missing).toMatchObject({ code: 66, kind: 'ref' })
	})

	it('fetches a commit id by id, so a pin holds after the branch moves, and refuses a wrong pin', async () => {
		const repo = makeRepo(root, 'm')
		const pinned = repo.commit({ 'p.txt': 'pinned' })
		repo.commit({ 'p.txt': 'moved on' })
		const byRef = await cloneRepository({ url: repo.url, ref: pinned, dest: join(root, 'a') }, file)
		expect(byRef.commit).toBe(pinned)
		expect(readFileSync(join(root, 'a', 'p.txt'), 'utf8')).toBe('pinned')
		const bySha = await cloneRepository({ url: repo.url, sha: pinned, dest: join(root, 'b') }, file)
		expect(bySha.commit).toBe(pinned)
		const wrong = await failure(
			cloneRepository({ url: repo.url, sha: 'f'.repeat(40), dest: join(root, 'c') }, file),
		)
		expect(wrong.kind).toBe('ref')
	})

	it('checks out only the sparse folders (plus the files at the top)', async () => {
		const repo = makeRepo(root, 'mono')
		repo.commit({
			'README.md': 'top',
			'plugins/ledger/plugin.txt': 'ledger',
			'plugins/other/plugin.txt': 'other',
			'docs/guide.md': 'guide',
		})
		const dest = join(root, 'out')
		await cloneRepository({ url: repo.url, sparsePaths: ['plugins/ledger'], dest }, file)
		expect(existsSync(join(dest, 'plugins/ledger/plugin.txt'))).toBe(true)
		expect(existsSync(join(dest, 'plugins/other/plugin.txt'))).toBe(false)
		expect(existsSync(join(dest, 'docs/guide.md'))).toBe(false)
		expect(existsSync(join(dest, 'README.md'))).toBe(true)
		// A pinned sparse fetch goes the same way.
		const head = git(repo.work, 'rev-parse', 'HEAD')
		await cloneRepository(
			{ url: repo.url, sha: head, sparsePaths: ['docs'], dest: join(root, 'out2') },
			file,
		)
		expect(existsSync(join(root, 'out2', 'docs/guide.md'))).toBe(true)
		expect(existsSync(join(root, 'out2', 'plugins/ledger/plugin.txt'))).toBe(false)
	})

	it('counts LFS pointers and submodules and downloads neither', async () => {
		const repo = makeRepo(root, 'hostile')
		const sub = makeRepo(root, 'sub')
		const subCommit = sub.commit({ 'inside.txt': 'from the submodule' })
		repo.commit({
			'big.bin': `version https://git-lfs.github.com/spec/v1\noid sha256:${'a'.repeat(64)}\nsize 1048576\n`,
			'also.bin': `version https://git-lfs.github.com/spec/v1\noid sha256:${'b'.repeat(64)}\nsize 5\n`,
			'real.txt': 'not a pointer',
		})
		git(repo.work, 'submodule', 'add', '--quiet', sub.url, 'vendor/sub')
		git(repo.work, 'commit', '--quiet', '-m', 'add submodule')
		git(repo.work, 'push', '--quiet', 'origin', 'HEAD:main')
		const dest = join(root, 'out')
		const result = await cloneRepository({ url: repo.url, dest }, file)
		expect(result.lfsPointers).toBe(2)
		expect(result.submodules).toBe(1)
		// Listed, not fetched: the folder is empty and the submodule's commit is nowhere in it.
		expect(existsSync(join(dest, 'vendor/sub/inside.txt'))).toBe(false)
		expect(subCommit).toHaveLength(40)
	})

	it('never runs a hook the repository ships and never makes a link out of the repository', async () => {
		const repo = makeRepo(root, 'hostile')
		const marker = join(root, 'RAN')
		const hook = `#!/bin/sh\necho ran > ${marker}\n`
		repo.commit({
			'hooks/post-checkout': { content: hook, mode: 0o755 },
			'.githooks/post-checkout': { content: hook, mode: 0o755 },
			'.gitattributes': '* filter=evil\n',
			'safe.txt': 'ok',
		})
		// A link that points out of the repository.
		const { symlinkSync } = await import('node:fs')
		symlinkSync('/etc/passwd', join(repo.work, 'passwd-link'))
		git(repo.work, 'add', '-A')
		git(repo.work, 'commit', '--quiet', '-m', 'link')
		git(repo.work, 'push', '--quiet', 'origin', 'HEAD:main')
		const dest = join(root, 'out')
		await cloneRepository({ url: repo.url, dest }, file)
		expect(existsSync(marker)).toBe(false)
		// core.symlinks=false: the link arrives as a plain file holding its target, not a link.
		expect(lstatSync(join(dest, 'passwd-link')).isSymbolicLink()).toBe(false)
		expect(readFileSync(join(dest, 'passwd-link'), 'utf8')).toBe('/etc/passwd')
		expect(readFileSync(join(dest, 'safe.txt'), 'utf8')).toBe('ok')
	})
})

describe('a repository that lies', () => {
	it('is refused by the integrity check when its submodule file names a command to run', async () => {
		const repo = makeRepo(root, 'liar')
		const marker = join(root, 'RAN')
		repo.commit({
			'.gitmodules': `[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x.git\n\tupdate = !touch ${marker}\n`,
			'safe.txt': 'ok',
		})
		const error = await failure(cloneRepository({ url: repo.url, dest: join(root, 'out') }, file))
		expect(error).toMatchObject({ code: 65, kind: 'fsck' })
		expect(existsSync(marker)).toBe(false)
	})
})

describe('what is never cloned', () => {
	it('refuses addresses that are not https or ssh before git is started', async () => {
		let started = 0
		const runner = async (): Promise<GitRun> => {
			started++
			return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
		}
		for (const url of [
			'http://example.com/x.git',
			'ext::sh -c id',
			'--upload-pack=touch /tmp/x',
			'git://example.com/x.git',
			'file:///tmp/x',
			'/tmp/x',
		]) {
			const error = await failure(cloneRepository({ url, dest: join(root, 'o') }, { runner }))
			expect(error.code, url).toBe(64)
		}
		expect(started).toBe(0)
	})

	it('refuses a ref or sparse path that could pass as an option', async () => {
		const runner = async (): Promise<GitRun> => ({
			code: 0,
			stdout: '',
			stderr: '',
			timedOut: false,
			missing: false,
		})
		const error = await failure(
			cloneRepository(
				{ url: 'https://example.com/x.git', sparsePaths: ['--no-index'], dest: join(root, 'o') },
				{ runner },
			),
		)
		expect(error.code).toBe(64)
	})

	it('passes git the scrubbed environment and every setting, and a credential prompt cannot appear', async () => {
		const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = []
		const runner = async (
			args: readonly string[],
			options: { env: NodeJS.ProcessEnv },
		): Promise<GitRun> => {
			calls.push({ args, env: options.env })
			if (args.includes('clone'))
				return {
					code: 128,
					stdout: '',
					stderr:
						"fatal: could not read Username for 'https://example.com': terminal prompts disabled",
					timedOut: false,
					missing: false,
				}
			return { code: 0, stdout: '', stderr: '', timedOut: false, missing: false }
		}
		const error = await failure(
			cloneRepository(
				{ url: 'https://example.com/private.git', dest: join(root, 'o') },
				{ runner, env: { PATH: '/bin', GIT_DIR: '/x', GIT_ASKPASS: '/ask' } },
			),
		)
		expect(error).toMatchObject({ code: 66, kind: 'auth' })
		const call = calls[0]
		expect(call?.env.GIT_TERMINAL_PROMPT).toBe('0')
		expect(call?.env.GIT_ASKPASS).toBe('')
		expect(call?.env.GIT_DIR).toBeUndefined()
		const args = call?.args ?? []
		expect(args.join(' ')).toContain('transfer.fsckObjects=true')
		expect(args).toContain('--depth')
		expect(args).toContain('--no-recurse-submodules')
		// The address comes after `--`, so it can never be read as an option.
		expect(args.indexOf('--')).toBeLessThan(args.indexOf('https://example.com/private.git'))
	})
})

describe('timeouts are an error a person can act on', () => {
	it('turns a stopped run into the timeout sentence with the exit status 69', async () => {
		const runner = async (): Promise<GitRun> => ({
			code: null,
			stdout: '',
			stderr: '',
			timedOut: true,
			missing: false,
		})
		const error = await failure(
			cloneRepository(
				{ url: 'https://example.com/x.git', dest: join(root, 'o') },
				{ runner, timeoutMs: 5000 },
			),
		)
		expect(error).toMatchObject({ code: 69, kind: 'timeout' })
		expect(error.message).toContain('5 seconds')
		mkdirSync(join(root, 'unused'), { recursive: true })
		writeFileSync(join(root, 'unused', 'f'), '')
	})
})
