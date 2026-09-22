import { execFileSync, spawn } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Sandbox, SandboxExecOptions, SandboxExecResult } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type SandboxSeed,
	SandboxSeedError,
	defineSandboxSeed,
	ensureSandboxSeed,
	sandboxSeedDigest,
} from '../index.js'

/**
 * `ensureSandboxSeed` against a real `sh` and a real `git`, with no network.
 *
 * The fake `Sandbox` runs each `exec` on this machine. Repositories are local
 * bare repositories, and the seed names them by an `https://seed.test/` URL
 * that git rewrites to the local path through `url.<base>.insteadOf`, set in
 * the environment the fake sandbox adds to every command. So the URL rules the
 * seed enforces are the real ones, and nothing leaves the machine.
 */

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: {
			...process.env,
			GIT_AUTHOR_NAME: 't',
			GIT_AUTHOR_EMAIL: 't@example.invalid',
			GIT_COMMITTER_NAME: 't',
			GIT_COMMITTER_EMAIL: 't@example.invalid',
			GIT_CONFIG_NOSYSTEM: '1',
			HOME: cwd,
		},
	}).trim()
}

/** Whether this machine lets an unprivileged process open a PID namespace. */
function unshareWorks(): boolean {
	try {
		return (
			execFileSync('unshare', ['-rpf', 'sh', '-c', 'echo $$'], { encoding: 'utf8' }).trim() === '1'
		)
	} catch {
		return false
	}
}

interface FakeSandbox extends Sandbox {
	readonly scripts: string[]
}

function fakeSandbox(
	remotes: string,
	extraEnv: Record<string, string> = {},
	spawnCommand?: (command: string) => string,
	unshare = false,
): FakeSandbox {
	const scripts: string[] = []
	const sandbox = {
		id: 'sbx_fake',
		status: 'ready',
		rootDir: '/',
		environment: 'basic',
		scripts,
		exec(command: string, args: string[] = [], opts: SandboxExecOptions = {}) {
			// The script and every argument it was handed, so a test can ask
			// what reached the guest's command line.
			if (command === 'sh' && args[0] === '-c') scripts.push(args.slice(1).join('\n'))
			return new Promise<SandboxExecResult>((resolve, reject) => {
				const started = Date.now()
				const argv = unshare ? ['-rpf', command, ...args] : args
				const child = spawn(spawnCommand ? spawnCommand(command) : command, argv, {
					env: {
						...process.env,
						GIT_CONFIG_NOSYSTEM: '1',
						GIT_CONFIG_GLOBAL: '/dev/null',
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: `url.file://${remotes}/.insteadOf`,
						GIT_CONFIG_VALUE_0: 'https://seed.test/',
						...extraEnv,
						...opts.env,
					},
				})
				let stdout = ''
				let stderr = ''
				child.stdout.on('data', (chunk) => {
					stdout += chunk
				})
				child.stderr.on('data', (chunk) => {
					stderr += chunk
				})
				child.on('error', reject)
				child.on('close', (code) =>
					resolve({
						exitCode: code ?? 1,
						stdout,
						stderr,
						timedOut: false,
						durationMs: Date.now() - started,
					}),
				)
			})
		},
	}
	return sandbox as unknown as FakeSandbox
}

describe('ensureSandboxSeed', () => {
	let work: string
	let remotes: string
	let root: string
	let firstCommit: string
	let secondCommit: string

	function makeRemote(name: string): { first: string; second: string } {
		const source = join(work, `src-${name}`)
		mkdirSync(source)
		git(source, 'init', '--quiet', '--initial-branch=main')
		writeFileSync(join(source, 'README'), `${name} one\n`)
		git(source, 'add', 'README')
		git(source, 'commit', '--quiet', '-m', 'one')
		const first = git(source, 'rev-parse', 'HEAD')
		writeFileSync(join(source, 'README'), `${name} two\n`)
		git(source, 'commit', '--quiet', '-am', 'two')
		const second = git(source, 'rev-parse', 'HEAD')
		git(work, 'clone', '--quiet', '--bare', source, join(remotes, `${name}.git`))
		return { first, second }
	}

	beforeEach(() => {
		work = mkdtempSync(join(tmpdir(), 'namzu-seed-'))
		remotes = join(work, 'remotes')
		root = join(work, 'root')
		mkdirSync(remotes)
		mkdirSync(root)
		const app = makeRemote('app')
		firstCommit = app.first
		secondCommit = app.second
		makeRemote('lib')
	})

	afterEach(() => {
		rmSync(work, { recursive: true, force: true })
	})

	const seed: SandboxSeed = {
		name: 'dev',
		repositories: [{ name: 'app', url: 'https://seed.test/app.git' }],
	}

	function clones(sandbox: FakeSandbox): number {
		return sandbox.scripts.filter((script) => script.includes('clone --quiet')).length
	}

	it('clones a missing repository into place and records it', async () => {
		const sandbox = fakeSandbox(remotes)
		const report = await ensureSandboxSeed(sandbox, seed, { root })
		expect(report).toEqual({
			digest: sandboxSeedDigest(seed),
			repositories: [{ name: 'app', status: 'cloned', commit: secondCommit }],
		})
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app two\n')
		const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
		expect(marker).toEqual({
			seed: 'dev',
			digest: sandboxSeedDigest(seed),
			commits: { app: secondCommit },
			refs: { app: '' },
		})
		expect(readdirSync(root).filter((name) => name.includes('namzu-partial'))).toEqual([])
	})

	it('only checks on a second call', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(sandbox, seed, { root })
		const report = await ensureSandboxSeed(sandbox, seed, { root })
		expect(report.repositories).toEqual([{ name: 'app', status: 'present', commit: secondCommit }])
		expect(clones(sandbox)).toBe(1)
	})

	it('clones only the repository that was added', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(sandbox, seed, { root })
		const report = await ensureSandboxSeed(
			sandbox,
			{
				name: 'dev',
				repositories: [
					...seed.repositories,
					{ name: 'lib', url: 'https://seed.test/lib.git', dir: 'vendor/lib' },
				],
			},
			{ root },
		)
		expect(report.repositories.map((repo) => [repo.name, repo.status])).toEqual([
			['app', 'present'],
			['lib', 'cloned'],
		])
		expect(existsSync(join(root, 'vendor/lib/README'))).toBe(true)
		expect(clones(sandbox)).toBe(2)
	})

	it('checks out a pinned commit and holds the repository to it', async () => {
		const pinned: SandboxSeed = {
			name: 'dev',
			repositories: [{ name: 'app', url: 'https://seed.test/app.git', commit: firstCommit }],
		}
		const sandbox = fakeSandbox(remotes)
		const report = await ensureSandboxSeed(sandbox, pinned, { root })
		expect(report.repositories[0]).toEqual({ name: 'app', status: 'cloned', commit: firstCommit })
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app one\n')

		// History rewritten under the pin: the pinned commit is no longer an
		// ancestor of HEAD. Refused, and nothing is touched.
		const orphan = join(root, 'app')
		git(orphan, 'checkout', '--quiet', '--orphan', 'other')
		git(orphan, 'commit', '--quiet', '-m', 'rewritten')
		const rewritten = git(orphan, 'rev-parse', 'HEAD')
		await expect(ensureSandboxSeed(sandbox, pinned, { root })).rejects.toMatchObject({
			code: 'drift',
			repository: 'app',
		})
		expect(git(orphan, 'rev-parse', 'HEAD')).toBe(rewritten)
	})

	it('treats a changed pin as drift over the old checkout, never recording the new pin', async () => {
		const pin = (commit: string): SandboxSeed => ({
			name: 'dev',
			repositories: [{ name: 'app', url: 'https://seed.test/app.git', commit }],
		})
		const sandbox = fakeSandbox(remotes)
		const first = await ensureSandboxSeed(sandbox, pin(secondCommit), { root })
		expect(first.repositories[0]).toEqual({ name: 'app', status: 'cloned', commit: secondCommit })
		// The older pin is an ancestor of the checkout, which is not holding it.
		await expect(ensureSandboxSeed(sandbox, pin(firstCommit), { root })).rejects.toMatchObject({
			code: 'drift',
			repository: 'app',
			message: expect.stringMatching(/app is not checked out at its pinned commit/),
		})
		const reported = await ensureSandboxSeed(sandbox, pin(firstCommit), { root, onDrift: 'report' })
		expect(reported.repositories).toEqual([
			{ name: 'app', status: 'drifted', commit: secondCommit },
		])
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app two\n')
		const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
		expect(marker.commits.app).toBe(secondCommit)
		// The recorded pin still holds by the ancestor rule.
		const back = await ensureSandboxSeed(sandbox, pin(secondCommit), { root })
		expect(back.repositories[0]?.status).toBe('present')
	})

	it('treats a ref-to-pin change as drift when the checkout is not the pinned commit', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(
			sandbox,
			{
				name: 'dev',
				repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref: 'main', depth: 2 }],
			},
			{ root },
		)
		await expect(
			ensureSandboxSeed(
				sandbox,
				{
					name: 'dev',
					repositories: [{ name: 'app', url: 'https://seed.test/app.git', commit: firstCommit }],
				},
				{ root },
			),
		).rejects.toMatchObject({ code: 'drift', repository: 'app' })
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app two\n')
	})

	it('treats a changed ref as drift and keeps the old checkout, never reporting it present', async () => {
		// A branch 'old' at the first commit, beside main at the second.
		const bare = join(remotes, 'app.git')
		git(bare, 'branch', 'old', firstCommit)
		const onRef = (ref: string): SandboxSeed => ({
			name: 'dev',
			repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref }],
		})
		const sandbox = fakeSandbox(remotes)
		const first = await ensureSandboxSeed(sandbox, onRef('main'), { root })
		expect(first.repositories[0]).toEqual({ name: 'app', status: 'cloned', commit: secondCommit })

		await expect(ensureSandboxSeed(sandbox, onRef('old'), { root })).rejects.toMatchObject({
			code: 'drift',
			repository: 'app',
			message: expect.stringMatching(/app does not hold the seed's ref/),
		})
		const reported = await ensureSandboxSeed(sandbox, onRef('old'), { root, onDrift: 'report' })
		expect(reported.repositories).toEqual([
			{ name: 'app', status: 'drifted', commit: secondCommit },
		])
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app two\n')
		// The marker does not claim the old checkout for the new ref.
		const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
		expect(marker.commits).toEqual({})
		expect(clones(sandbox)).toBe(1)

		// Back on main, it is the same checkout again.
		const back = await ensureSandboxSeed(sandbox, onRef('main'), { root })
		expect(back.repositories[0]?.status).toBe('present')
	})

	it('accepts a ref the checkout already holds, and records it', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(sandbox, seed, { root })
		const named: SandboxSeed = {
			name: 'dev',
			repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref: 'main' }],
		}
		const report = await ensureSandboxSeed(sandbox, named, { root })
		expect(report.repositories[0]).toEqual({ name: 'app', status: 'present', commit: secondCommit })
		const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
		expect(marker).toMatchObject({ commits: { app: secondCommit }, refs: { app: 'main' } })
		expect(clones(sandbox)).toBe(1)
	})

	it('clones a tag, and holds a later call to it', async () => {
		git(join(remotes, 'app.git'), 'tag', 'v1', firstCommit)
		const tagged: SandboxSeed = {
			name: 'dev',
			repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref: 'v1' }],
		}
		const sandbox = fakeSandbox(remotes)
		const first = await ensureSandboxSeed(sandbox, tagged, { root })
		expect(first.repositories[0]).toEqual({ name: 'app', status: 'cloned', commit: firstCommit })
		// Without the marker the tag is found in the repository itself.
		rmSync(join(root, '.namzu/seed/dev.json'))
		const again = await ensureSandboxSeed(sandbox, tagged, { root })
		expect(again.repositories[0]).toEqual({ name: 'app', status: 'present', commit: firstCommit })
		// And main is not the tag's checkout.
		await expect(
			ensureSandboxSeed(
				sandbox,
				{ ...tagged, repositories: [{ ...tagged.repositories[0]!, ref: 'main' }] },
				{ root },
			),
		).rejects.toMatchObject({ code: 'drift' })
	})

	it('refuses a changed ref that a deeper clone carries in its history', async () => {
		// depth 2 fetches the tag v0 at the older commit along with main.
		git(join(remotes, 'app.git'), 'tag', 'v0', firstCommit)
		const onRef = (ref: string): SandboxSeed => ({
			name: 'dev',
			repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref, depth: 2 }],
		})
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(sandbox, onRef('main'), { root })
		expect(git(join(root, 'app'), 'rev-parse', 'refs/tags/v0')).toBe(firstCommit)

		await expect(ensureSandboxSeed(sandbox, onRef('v0'), { root })).rejects.toMatchObject({
			code: 'drift',
			repository: 'app',
			message: expect.stringMatching(/app does not hold the seed's ref/),
		})
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app two\n')
		const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
		expect(marker).toMatchObject({ commits: { app: secondCommit }, refs: { app: 'main' } })
	})

	it.each([
		['behind the checkout', 'second', 'old'],
		['ahead of the checkout', 'first', 'main'],
	] as const)(
		'refuses a ref %s after a pinned commit, whose full clone has every branch',
		async (_, pin, ref) => {
			git(join(remotes, 'app.git'), 'branch', 'old', firstCommit)
			const commit = pin === 'first' ? firstCommit : secondCommit
			const sandbox = fakeSandbox(remotes)
			await ensureSandboxSeed(
				sandbox,
				{ name: 'dev', repositories: [{ name: 'app', url: 'https://seed.test/app.git', commit }] },
				{ root },
			)
			const onRef: SandboxSeed = {
				name: 'dev',
				repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref }],
			}
			await expect(ensureSandboxSeed(sandbox, onRef, { root })).rejects.toMatchObject({
				code: 'drift',
				repository: 'app',
			})
			const reported = await ensureSandboxSeed(sandbox, onRef, { root, onDrift: 'report' })
			expect(reported.repositories).toEqual([{ name: 'app', status: 'drifted', commit }])
			// The pin's record is not written under the new ref.
			const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
			expect(marker.commits).toEqual({})
			expect(git(join(root, 'app'), 'rev-parse', 'HEAD')).toBe(commit)
		},
	)

	it('does not let a dropped pin stand in for the default branch', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(
			sandbox,
			{
				name: 'dev',
				repositories: [{ name: 'app', url: 'https://seed.test/app.git', commit: firstCommit }],
			},
			{ root },
		)
		const marker = JSON.parse(readFileSync(join(root, '.namzu/seed/dev.json'), 'utf8'))
		expect(marker.refs).toEqual({ app: ':commit' })
		// The default branch is main at the second commit; HEAD is the pin.
		await expect(ensureSandboxSeed(sandbox, seed, { root })).rejects.toMatchObject({
			code: 'drift',
			repository: 'app',
		})
		expect(readFileSync(join(root, 'app', 'README'), 'utf8')).toBe('app one\n')
	})

	it('holds a seed with no ref and no record to the default branch', async () => {
		git(join(remotes, 'app.git'), 'branch', 'old', firstCommit)
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(
			sandbox,
			{
				name: 'dev',
				repositories: [{ name: 'app', url: 'https://seed.test/app.git', ref: 'old' }],
			},
			{ root },
		)
		// Dropping the ref: a checkout of 'old' is not the default branch.
		await expect(ensureSandboxSeed(sandbox, seed, { root })).rejects.toMatchObject({
			code: 'drift',
			repository: 'app',
		})
		// A default clone with its marker gone is found through origin/HEAD.
		rmSync(join(root, 'app'), { recursive: true, force: true })
		rmSync(join(root, '.namzu/seed/dev.json'))
		await ensureSandboxSeed(sandbox, seed, { root })
		rmSync(join(root, '.namzu/seed/dev.json'))
		const again = await ensureSandboxSeed(sandbox, seed, { root })
		expect(again.repositories[0]).toEqual({ name: 'app', status: 'present', commit: secondCommit })
	})

	it('refuses drift by default, changing nothing, and reports it on request', async () => {
		const foreign = join(root, 'app')
		git(work, 'clone', '--quiet', join(remotes, 'lib.git'), foreign)
		const before = git(foreign, 'rev-parse', 'HEAD')
		const sandbox = fakeSandbox(remotes)

		const refused = ensureSandboxSeed(sandbox, seed, { root })
		await expect(refused).rejects.toBeInstanceOf(SandboxSeedError)
		await expect(ensureSandboxSeed(sandbox, seed, { root })).rejects.toMatchObject({
			code: 'drift',
			message: expect.stringMatching(/app has a different origin URL/),
		})
		expect(clones(sandbox)).toBe(0)

		const reported = await ensureSandboxSeed(sandbox, seed, { root, onDrift: 'report' })
		expect(reported.repositories).toEqual([{ name: 'app', status: 'drifted', commit: before }])
		expect(git(foreign, 'rev-parse', 'HEAD')).toBe(before)
		expect(readFileSync(join(foreign, 'README'), 'utf8')).toBe('lib two\n')
	})

	it('treats a directory that is not a repository as drift, and leaves it alone', async () => {
		mkdirSync(join(root, 'app'))
		writeFileSync(join(root, 'app', 'notes.txt'), 'mine\n')
		await expect(ensureSandboxSeed(fakeSandbox(remotes), seed, { root })).rejects.toMatchObject({
			code: 'drift',
			message: expect.stringMatching(/not a git repository/),
		})
		expect(readFileSync(join(root, 'app', 'notes.txt'), 'utf8')).toBe('mine\n')
	})

	it('does not trust a forged marker: a missing repository is still cloned', async () => {
		mkdirSync(join(root, '.namzu/seed'), { recursive: true })
		writeFileSync(
			join(root, '.namzu/seed/dev.json'),
			JSON.stringify({
				seed: 'dev',
				digest: sandboxSeedDigest(seed),
				commits: { app: secondCommit },
			}),
		)
		const sandbox = fakeSandbox(remotes)
		const report = await ensureSandboxSeed(sandbox, seed, { root })
		expect(report.repositories[0]?.status).toBe('cloned')
		expect(existsSync(join(root, 'app', 'README'))).toBe(true)
	})

	it('does not trust a forged marker commit: it is checked, and a non-commit is ignored', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(sandbox, seed, { root })
		const markerPath = join(root, '.namzu/seed/dev.json')

		// A commit id that is not in the repository's history is drift.
		writeFileSync(
			markerPath,
			JSON.stringify({ commits: { app: 'f'.repeat(40) }, refs: { app: '' } }),
		)
		await expect(ensureSandboxSeed(sandbox, seed, { root })).rejects.toMatchObject({
			code: 'drift',
		})

		// A value that is not a commit id never reaches git as an argument.
		writeFileSync(
			markerPath,
			JSON.stringify({ commits: { app: '--upload-pack=touch /tmp/x' }, refs: { app: '' } }),
		)
		const report = await ensureSandboxSeed(sandbox, seed, { root })
		expect(report.repositories[0]?.status).toBe('present')
		expect(sandbox.scripts.join('\n')).not.toContain('--upload-pack')
	})

	it('survives a crash before the move: the stale partial is swept, a peer’s fresh one is not', async () => {
		const stale = join(root, 'app.namzu-partial-crashed')
		const fresh = join(root, 'app.namzu-partial-peer')
		mkdirSync(stale)
		mkdirSync(fresh)
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
		utimesSync(stale, twoHoursAgo, twoHoursAgo)

		const report = await ensureSandboxSeed(fakeSandbox(remotes), seed, { root })
		expect(report.repositories[0]?.status).toBe('cloned')
		expect(existsSync(stale)).toBe(false)
		expect(existsSync(fresh)).toBe(true)
	})

	it('lets two concurrent calls on one root both succeed, with one clone in place', async () => {
		const [a, b] = await Promise.all([
			ensureSandboxSeed(fakeSandbox(remotes), seed, { root }),
			ensureSandboxSeed(fakeSandbox(remotes), seed, { root }),
		])
		for (const status of [a.repositories[0]?.status, b.repositories[0]?.status]) {
			expect(['cloned', 'present']).toContain(status)
		}
		expect(a.repositories[0]?.commit).toBe(secondCommit)
		expect(b.repositories[0]?.commit).toBe(secondCommit)
		expect(readdirSync(root).filter((name) => name.includes('namzu-partial'))).toEqual([])
		expect(git(join(root, 'app'), 'rev-parse', 'HEAD')).toBe(secondCommit)
	})

	it('names the marker temporary by the call, not by the shell PID', async () => {
		const sandbox = fakeSandbox(remotes)
		await ensureSandboxSeed(sandbox, seed, { root })
		// Sandboxes sharing one disk often run the script as the same PID, each
		// in its own PID namespace, so '$$' would name one file for both.
		expect(sandbox.scripts.join('\n')).not.toContain('$$')
	})

	it.skipIf(!unshareWorks())(
		'lets concurrent calls from separate PID namespaces write the marker',
		async () => {
			// Every exec runs as PID 1 in a namespace of its own, as in containers.
			const isolated = () => fakeSandbox(remotes, {}, () => 'unshare', true)
			await ensureSandboxSeed(isolated(), seed, { root })
			const results = await Promise.allSettled(
				Array.from({ length: 40 }, () => ensureSandboxSeed(isolated(), seed, { root })),
			)
			expect(results.filter((result) => result.status === 'rejected')).toEqual([])
		},
		60_000,
	)

	it('refuses a missing or relative root', async () => {
		for (const bad of [undefined, '', 'relative/path', '/a/../b']) {
			await expect(
				ensureSandboxSeed(fakeSandbox(remotes), seed, { root: bad } as never),
			).rejects.toMatchObject({ code: 'invalid' })
		}
	})

	it('names the tool the guest is missing', async () => {
		// A PATH with sh and coreutils but no git.
		const bin = join(work, 'bin')
		mkdirSync(bin)
		for (const tool of ['sh', 'find', 'mkdir', 'mktemp', 'rm', 'mv', 'cat', 'dirname']) {
			const found = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
			symlinkSync(found, join(bin, tool))
		}
		await expect(
			ensureSandboxSeed(fakeSandbox(remotes, { PATH: bin }), seed, { root }),
		).rejects.toMatchObject({ code: 'tool-missing', message: expect.stringMatching(/no git/) })
	})

	it('names sh when the guest cannot run it at all', async () => {
		await expect(
			ensureSandboxSeed(
				fakeSandbox(remotes, {}, () => join(work, 'no-such-sh')),
				seed,
				{ root },
			),
		).rejects.toMatchObject({
			code: 'tool-missing',
			message: expect.stringMatching(/could not run sh/),
		})
	})

	it('reports a failed clone by repository', async () => {
		await expect(
			ensureSandboxSeed(
				fakeSandbox(remotes),
				{ name: 'dev', repositories: [{ name: 'gone', url: 'https://seed.test/gone.git' }] },
				{ root },
			),
		).rejects.toMatchObject({ code: 'clone-failed', repository: 'gone' })
		expect(readdirSync(root).filter((name) => name.includes('namzu-partial'))).toEqual([])
	})
})

describe('defineSandboxSeed', () => {
	const repo = { name: 'app', url: 'https://example.com/app.git' }

	it.each([
		['ssh://git@example.com/app.git', /uses ssh/],
		['git@example.com:org/app.git', /scp-style SSH address/],
		['https://token@example.com/app.git', /user name or password/],
		['https://user:pass@example.com/app.git', /user name or password/],
		['file:///srv/app.git', /uses file/],
		['ext::sh -c touch% /tmp/x', /not a URL|uses ext/],
		['not a url', /not a URL/],
	])('refuses the URL %j', (url, message) => {
		expect(() => defineSandboxSeed({ name: 's', repositories: [{ ...repo, url }] })).toThrow(
			message,
		)
	})

	it('does not echo a credential it refuses', () => {
		try {
			defineSandboxSeed({
				name: 's',
				repositories: [{ ...repo, url: 'https://user:hunter2@example.com/app.git' }],
			})
		} catch (error) {
			expect(String(error)).not.toContain('hunter2')
			return
		}
		throw new Error('expected a refusal')
	})

	it('accepts https and http', () => {
		expect(() =>
			defineSandboxSeed({
				name: 's',
				repositories: [repo, { name: 'priv', url: 'http://git.example.com/org/priv.git' }],
			}),
		).not.toThrow()
	})

	it.each([
		[{ ...repo, dir: '../escape' }, /relative path/],
		[{ ...repo, dir: '/abs' }, /relative path/],
		[{ ...repo, ref: '--upload-pack=x' }, /not a branch or tag/],
		[{ ...repo, ref: 'a..b' }, /not a branch or tag/],
		[{ ...repo, commit: 'abc' }, /not a full lowercase commit id/],
		[{ ...repo, depth: 0 }, /not a positive integer/],
		[{ ...repo, commit: 'a'.repeat(40), depth: 5 }, /depth is set beside commit/],
		[{ ...repo, name: 'Bad' }, /not a DNS-1123 label/],
	])('refuses %j', (bad, message) => {
		expect(() => defineSandboxSeed({ name: 's', repositories: [bad] })).toThrow(message)
	})

	it.each([
		[
			[
				{ ...repo, dir: 'vendor' },
				{ ...repo, name: 'lib', dir: 'vendor/lib' },
			],
			/are nested/,
		],
		[
			[
				{ ...repo, name: 'lib', dir: 'vendor/lib' },
				{ ...repo, dir: 'vendor' },
			],
			/are nested/,
		],
		[[{ ...repo, dir: '.namzu/app' }], /reserved/],
		[[{ ...repo, dir: '.namzu' }], /reserved/],
		[[{ ...repo, dir: 'app.namzu-partial-x' }], /reserved/],
	])('refuses the directories %j', (repositories, message) => {
		expect(() => defineSandboxSeed({ name: 's', repositories })).toThrow(message)
	})

	it('accepts sibling directories that share a prefix', () => {
		expect(() =>
			defineSandboxSeed({
				name: 's',
				repositories: [
					{ ...repo, dir: 'vendor/lib' },
					{ ...repo, name: 'lib2', dir: 'vendor/lib2' },
				],
			}),
		).not.toThrow()
	})

	it('refuses a repeated name, a shared directory and an empty seed', () => {
		expect(() => defineSandboxSeed({ name: 's', repositories: [repo, repo] })).toThrow(
			/listed twice/,
		)
		expect(() =>
			defineSandboxSeed({
				name: 's',
				repositories: [repo, { ...repo, name: 'other', dir: 'app' }],
			}),
		).toThrow(/used by another repository/)
		expect(() => defineSandboxSeed({ name: 's', repositories: [] })).toThrow(/at least one/)
	})

	it('digests content, not key order', () => {
		expect(sandboxSeedDigest({ name: 's', repositories: [repo] })).toBe(
			sandboxSeedDigest({ repositories: [{ url: repo.url, name: repo.name }], name: 's' }),
		)
		expect(sandboxSeedDigest({ name: 's', repositories: [repo] })).not.toBe(
			sandboxSeedDigest({ name: 's', repositories: [{ ...repo, ref: 'main' }] }),
		)
	})
})
