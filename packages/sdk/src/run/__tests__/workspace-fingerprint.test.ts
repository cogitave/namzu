/**
 * `fingerprintWorkspace` against a REAL repository.
 *
 * Real, not mocked, because every interesting property here is a property of
 * git's own output: whether `status --porcelain` moves when a
 * already-modified file is edited again (it does not), whether an untracked
 * file's content is anywhere in the output (it is not), what `-z` puts
 * between paths. A fake git would encode this file's guesses about those
 * answers and then confirm them.
 *
 * The one exception is the symlink rule, which needs a privilege Windows
 * does not grant by default — see the note on `FingerprintFs`.
 */

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { LocalExecutionContext } from '../../execution/local.js'
import type { CommandResult } from '../../types/execution/index.js'
import { fingerprintWorkspace } from '../workspace-fingerprint.js'

const exec = promisify(execFile)

let dir: string
let context: LocalExecutionContext

const run = (
	command: string,
	args: string[],
	options?: Parameters<typeof context.executeCommand>[2],
) => context.executeCommand(command, args, options)

async function git(...args: string[]): Promise<void> {
	await exec('git', args, { cwd: dir })
}

function fingerprint(over: { maxBytes?: number } = {}) {
	return fingerprintWorkspace({ cwd: dir, exec: run, ...over })
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'namzu-fp-'))
	context = new LocalExecutionContext({ id: 'fp-test', cwd: dir })
	await git('init', '-q')
	await git('config', 'user.email', 'test@example.invalid')
	await git('config', 'user.name', 'Test')
	await git('config', 'commit.gpgsign', 'false')
	await writeFile(join(dir, 'tracked.txt'), 'one\n')
	await git('add', '.')
	await git('commit', '-q', '-m', 'seed')
})

afterEach(async () => {
	await rm(dir, { recursive: true, force: true })
})

describe('what moves the fingerprint', () => {
	it('is stable when nothing has changed', async () => {
		const a = await fingerprint()
		const b = await fingerprint()
		expect(a).not.toBeNull()
		expect(a).toBe(b)
	})

	it('moves when a tracked file is edited', async () => {
		const before = await fingerprint()
		await writeFile(join(dir, 'tracked.txt'), 'two\n')
		expect(await fingerprint()).not.toBe(before)
	})

	it('moves when an ALREADY-modified tracked file is edited again', async () => {
		await writeFile(join(dir, 'tracked.txt'), 'two\n')
		const before = await fingerprint()
		await writeFile(join(dir, 'tracked.txt'), 'three\n')

		// `status --porcelain` is byte-identical across these two states — both
		// say ` M tracked.txt`. This is why the diff is hashed as well, and it
		// is the ordinary case in a fix loop: the second attempt edits a file
		// the first attempt already touched.
		const status = await run('git', ['status', '--porcelain'], { cwd: dir })
		expect(status.stdout.trim()).toBe('M tracked.txt')
		expect(await fingerprint()).not.toBe(before)
	})

	it('moves when a NEW file appears', async () => {
		const before = await fingerprint()
		await writeFile(join(dir, 'fresh.txt'), 'hello\n')
		expect(await fingerprint()).not.toBe(before)
	})

	it('moves when an untracked file is edited but not renamed', async () => {
		await writeFile(join(dir, 'fresh.txt'), 'hello\n')
		const before = await fingerprint()
		await writeFile(join(dir, 'fresh.txt'), 'goodbye\n')

		// No `git diff` covers an untracked file and `status` names only the
		// path, so without hashing the CONTENT this pair would be identical —
		// and a model iterating on a brand-new file would be told it had
		// changed nothing, every attempt.
		expect(await fingerprint()).not.toBe(before)
	})

	it('moves when a file is deleted', async () => {
		const before = await fingerprint()
		await rm(join(dir, 'tracked.txt'))
		expect(await fingerprint()).not.toBe(before)
	})

	it('ignores a file the repository ignores', async () => {
		await writeFile(join(dir, '.gitignore'), 'noise/\n')
		await git('add', '.gitignore')
		await git('commit', '-q', '-m', 'ignore')
		const before = await fingerprint()

		await mkdir(join(dir, 'noise'), { recursive: true })
		await writeFile(join(dir, 'noise', 'log.txt'), 'chatter\n')

		// Build output and caches move on their own. A fingerprint that
		// counted them would say "something changed" after every attempt and
		// the detector would never fire.
		expect(await fingerprint()).toBe(before)
	})
})

describe('when it cannot tell', () => {
	it('returns null outside a repository rather than a hash of nothing', async () => {
		const bare = await mkdtemp(join(tmpdir(), 'namzu-fp-bare-'))
		try {
			const ctx = new LocalExecutionContext({ id: 'fp-bare', cwd: bare })
			const fp = await fingerprintWorkspace({
				cwd: bare,
				exec: (c, a, o) => ctx.executeCommand(c, a, o),
			})
			expect(fp).toBeNull()
		} finally {
			await rm(bare, { recursive: true, force: true })
		}
	})

	it('returns null rather than hashing output it had to clip', async () => {
		await writeFile(join(dir, 'tracked.txt'), 'x'.repeat(5_000))
		// Two different large trees clipped at the same point produce the same
		// hash, and "the same hash" is read by the caller as "nothing changed"
		// — a verification silently skipped.
		expect(await fingerprint({ maxBytes: 64 })).toBeNull()
	})

	it.each(['stdoutTruncated', 'stderrTruncated'] as const)(
		'returns null when git reports %s even if its retained text is short',
		async (flag) => {
			const fp = await fingerprintWorkspace({
				cwd: dir,
				exec: async (): Promise<CommandResult> => ({
					exitCode: 0,
					stdout: '',
					stderr: '',
					durationMs: 1,
					[flag]: true,
				}),
			})

			expect(fp).toBeNull()
		},
	)

	it('returns null when git cannot be run at all', async () => {
		const fp = await fingerprintWorkspace({
			cwd: dir,
			exec: async (): Promise<CommandResult> => {
				throw new Error('no git on PATH')
			},
		})
		expect(fp).toBeNull()
	})
})

describe('a symlink is recorded as its target', () => {
	/**
	 * Simulated rather than created, because `symlink()` needs a privilege
	 * Windows does not grant by default — see the note on `FingerprintFs`.
	 * `exec` is still the real git above; only the three filesystem reads are
	 * replaced, and only for this one branch.
	 */
	function fsWith(target: string) {
		return {
			lstat: async () => ({ isSymbolicLink: () => true, isFile: () => false }),
			readlink: async () => target,
			readFile: async () => Buffer.from('the same bytes either way'),
		}
	}

	it('moves when the link is repointed, though what is behind it did not change', async () => {
		await writeFile(join(dir, 'link'), 'placeholder so git lists it as untracked\n')

		const before = await fingerprintWorkspace({ cwd: dir, exec: run, fs: fsWith('./a.txt') })
		const after = await fingerprintWorkspace({ cwd: dir, exec: run, fs: fsWith('./b.txt') })

		// `readFile` returns identical bytes in both cases — that is the whole
		// construction. Reading THROUGH the link would hash the two the same
		// and report a repointed workspace as untouched.
		expect(before).not.toBeNull()
		expect(after).not.toBe(before)
	})

	it('is stable when the link points where it pointed before', async () => {
		await writeFile(join(dir, 'link'), 'placeholder\n')
		const a = await fingerprintWorkspace({ cwd: dir, exec: run, fs: fsWith('./a.txt') })
		const b = await fingerprintWorkspace({ cwd: dir, exec: run, fs: fsWith('./a.txt') })
		// The guard: an implementation that hashed something incidental — a
		// timestamp, an inode — would move here too, and would then report
		// "changed" on every attempt.
		expect(a).toBe(b)
	})
})
