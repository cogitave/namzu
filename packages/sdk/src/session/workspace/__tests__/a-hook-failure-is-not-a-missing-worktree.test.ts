import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { WorkspaceBackendError } from '../../errors.js'
import { GitWorktreeDriver } from '../git-worktree.js'

/**
 * `git worktree add` runs the repository's post-checkout hook AFTER the
 * checkout completes. A hook that exits non-zero — or that a timeout kills
 * — therefore reports failure over a worktree that is finished and usable.
 *
 * Trusting the exit code throws that worktree away AND leaks it: the path
 * stays registered, so the next attempt fails differently, with "already
 * exists". So the status is a hint and the repository is the evidence.
 *
 * The bar is deliberately narrow. A registered path alone proves nothing —
 * it can be a half-finished checkout or one somebody else owns — so the
 * branch this call asked for has to be on it.
 */

const REPO = '/repo'
const WORKTREES = '/repo/.worktrees'
/**
 * The driver builds this with `path.join`, so it is backslash-separated on
 * Windows. The porcelain fixture has to carry the same string the driver
 * will look for, or the lookup misses for a reason that has nothing to do
 * with what is being tested.
 */
const W1 = join(WORKTREES, 'w1')

/** `git worktree list --porcelain` output for one registered worktree. */
function porcelain(path: string, branch: string): string {
	return ['', `worktree ${path}`, 'HEAD abc123', `branch ${branch}`, ''].join('\n')
}

function stubLogger(): never {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child() {
			return stubLogger()
		},
	} as never
}

function driverWith(exec: ReturnType<typeof vi.fn>) {
	return new GitWorktreeDriver({
		repoRoot: REPO,
		worktreesDir: WORKTREES,
		execFile: exec as never,
		logger: stubLogger(),
	})
}

describe('a worktree add that reports failure', () => {
	it('succeeds when the worktree arrived with the branch this call asked for', async () => {
		const exec = vi.fn(async (_bin: string, argv: string[]) => {
			if (argv.includes('add')) throw new Error('post-checkout hook exited 1')
			return { stdout: porcelain(W1, 'refs/heads/namzu/w1'), stderr: '' }
		})

		const ref = await driverWith(exec).create({ label: 'w1' })

		expect(ref.meta.worktreePath).toBe(W1)
		expect(ref.meta.branch).toBe('namzu/w1')
	})

	it('compares against the full ref the porcelain actually prints', async () => {
		// The check is `refs/heads/<branch>` because that is what git writes.
		// Comparing the short name would be a check that can never pass, and
		// this whole recovery would be dead while looking alive.
		const exec = vi.fn(async (_bin: string, argv: string[]) => {
			if (argv.includes('add')) throw new Error('hook failed')
			return { stdout: porcelain(W1, 'namzu/w1'), stderr: '' }
		})

		await expect(driverWith(exec).create({ label: 'w1' })).rejects.toBeInstanceOf(
			WorkspaceBackendError,
		)
	})

	it('still fails when the worktree is not there', async () => {
		const exec = vi.fn(async (_bin: string, argv: string[]) => {
			if (argv.includes('add')) throw new Error('fatal: invalid reference')
			return { stdout: '', stderr: '' }
		})

		await expect(driverWith(exec).create({ label: 'w1' })).rejects.toBeInstanceOf(
			WorkspaceBackendError,
		)
	})

	it('refuses a path registered under a different branch', async () => {
		// A leftover from a killed attempt and a checkout somebody else owns
		// are indistinguishable from here. Claiming either would hand the
		// caller a workspace whose contents nobody vouched for.
		const exec = vi.fn(async (_bin: string, argv: string[]) => {
			if (argv.includes('add')) throw new Error('hook failed')
			return { stdout: porcelain(W1, 'refs/heads/someone-elses'), stderr: '' }
		})

		await expect(driverWith(exec).create({ label: 'w1' })).rejects.toBeInstanceOf(
			WorkspaceBackendError,
		)
	})

	it('treats a failure to check as a failure', async () => {
		// This runs on a path that has already gone wrong once. Guessing
		// optimistically here turns a bad situation into a wrong one.
		const exec = vi.fn(async (_bin: string, argv: string[]) => {
			if (argv.includes('add')) throw new Error('hook failed')
			throw new Error('git list also failed')
		})

		await expect(driverWith(exec).create({ label: 'w1' })).rejects.toBeInstanceOf(
			WorkspaceBackendError,
		)
	})

	it('does not run the check at all when the add succeeded', async () => {
		// The recovery is for a failure. Listing on every create would pay a
		// subprocess on the happy path to learn something already known.
		const seen: string[][] = []
		const exec = vi.fn(async (_bin: string, argv: string[]) => {
			seen.push(argv)
			return { stdout: '', stderr: '' }
		})

		await driverWith(exec).create({ label: 'w1' })

		expect(seen).toHaveLength(1)
		expect(seen[0]).toContain('add')
	})
})
