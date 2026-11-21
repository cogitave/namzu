/**
 * A removal must not delete a checkout another running session or subagent is
 * working in. The driver asks the hold store first; a path nothing holds is
 * removed exactly as it was.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkspaceId } from '../../../types/ids/index.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { DiskWorkspaceHoldStore, WorkspaceInUseError } from '../holds.js'
import { type ExecFile, type ExecFileResult, GitWorktreeDriver } from '../git-worktree.js'

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stubLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child() {
			return stubLogger()
		},
	}
}

function ok(stdout = ''): ExecFileResult {
	return { stdout, stderr: '' }
}

interface Harness {
	readonly repoRoot: string
	readonly worktreesDir: string
	readonly checkout: string
	readonly ref: WorkspaceRef
	readonly exec: ExecFile
	readonly removed: string[]
}

/** A registered checkout whose `worktree list` entry is exactly this one. */
function harness(): Harness {
	const root = mkdtempSync(join(tmpdir(), 'namzu-worktree-holds-'))
	roots.push(root)
	const repoRoot = join(root, 'repo')
	const worktreesDir = join(root, 'worktrees')
	const checkout = join(worktreesDir, 'review')
	mkdirSync(repoRoot, { recursive: true })
	mkdirSync(checkout, { recursive: true })
	const ref: WorkspaceRef = {
		id: 'a224544c-9817-4e60-a141-1fcf5f8331ef' as WorkspaceId,
		meta: {
			backend: 'git-worktree',
			repoRoot,
			branch: 'namzu/review',
			worktreePath: checkout,
		},
		createdAt: new Date(),
	}
	const removed: string[] = []
	const exec: ExecFile = async (_file, args) => {
		if (args.includes('list')) {
			return ok(`worktree ${checkout}\nHEAD abc123\nbranch refs/heads/namzu/review\n`)
		}
		if (args.includes('remove')) {
			removed.push(checkout)
			return ok()
		}
		return ok()
	}
	return { repoRoot, worktreesDir, checkout, ref, exec, removed }
}

it('refuses a checkout a live session has open, and names both folders', async () => {
	const h = harness()
	const holds = new DiskWorkspaceHoldStore({ root: join(h.repoRoot, 'holds') })
	const release = await holds.add({
		path: h.checkout,
		folder: join(h.checkout, 'packages', 'sdk'),
		holder: 'session:4242',
	})
	const driver = new GitWorktreeDriver({
		repoRoot: h.repoRoot,
		worktreesDir: h.worktreesDir,
		logger: stubLogger(),
		execFile: h.exec,
		holds,
	})

	const failure = await driver.dispose(h.ref).catch((error: unknown) => error)

	expect(failure).toBeInstanceOf(WorkspaceInUseError)
	expect((failure as Error).message).toContain(h.checkout)
	expect((failure as Error).message).toContain(join(h.checkout, 'packages', 'sdk'))
	expect((failure as Error).message).toContain('session:4242')
	// Nothing was removed, so the session's uncommitted files are still there.
	expect(h.removed).toEqual([])

	await release()
	await driver.dispose(h.ref)
	expect(h.removed).toEqual([h.checkout])
})

it('removes a checkout nothing holds, as it did before', async () => {
	const h = harness()
	const holds = new DiskWorkspaceHoldStore({ root: join(h.repoRoot, 'holds') })
	// A hold on a different checkout must not block this one.
	await holds.add({ path: join(h.worktreesDir, 'other'), holder: 'session:1' })
	const driver = new GitWorktreeDriver({
		repoRoot: h.repoRoot,
		worktreesDir: h.worktreesDir,
		logger: stubLogger(),
		execFile: h.exec,
		holds,
	})

	await driver.dispose(h.ref)

	expect(h.removed).toEqual([h.checkout])
})

it('a holding whose process is gone no longer keeps the checkout', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-holds-dead-pid-'))
	roots.push(root)
	const holder = new DiskWorkspaceHoldStore({ root })
	const release = await holder.add({ path: join(root, 'review'), holder: 'session:9' })

	// The same files, read where the recording process does not exist.
	const after = new DiskWorkspaceHoldStore({ root, isPidAlive: () => false })
	expect(await after.holders(join(root, 'review'))).toEqual([])
	expect(await holder.holders(join(root, 'review'))).toEqual([])

	await release()
})