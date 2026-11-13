/**
 * HookedWorkspaceDriver: a create hook's folder is used and the kernel makes
 * none; failures never fall back; a folder a hook made is never removed by the
 * kernel's own Git logic; with no hook everything is the wrapped driver's.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import type { WorkspaceBackendDriver } from '../driver.js'
import {
	HookedWorkspaceDriver,
	WorktreeHookError,
	type WorktreeHookHost,
} from '../hooked-driver.js'

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'wt-driver-'))
	dirs.push(dir)
	return dir
}

function kernelRef(path: string): WorkspaceRef {
	return {
		id: 'ws_kernel' as WorkspaceRef['id'],
		meta: { backend: 'git-worktree', repoRoot: '/repo', branch: 'namzu/k', worktreePath: path },
		createdAt: new Date(),
	}
}

function innerDriver() {
	const inner = {
		kind: 'git-worktree' as const,
		create: vi.fn(async () => kernelRef('/kernel')),
		branch: vi.fn(async () => kernelRef('/kernel-branch')),
		dispose: vi.fn(async () => undefined),
		inspect: vi.fn(async () => ({ exists: true, currentRef: 'namzu/k', isDirty: false })),
	}
	return inner satisfies WorkspaceBackendDriver
}

function host(answers: {
	create?: PluginHookResult[]
	remove?: PluginHookResult[]
}): WorktreeHookHost & { calls: [string, unknown][] } {
	const calls: [string, unknown][] = []
	return {
		calls,
		execute: async (event, context) => {
			calls.push([event, context])
			return (event === 'worktree_create' ? answers.create : answers.remove) ?? []
		},
	}
}

describe('create', () => {
	it('is the wrapped driver when no hook is on the event', async () => {
		const inner = innerDriver()
		const driver = new HookedWorkspaceDriver({ inner, hooks: host({}), root: () => '/root' })
		const ref = await driver.create({ label: 'x' })
		expect(ref.meta.worktreePath).toBe('/kernel')
		expect(inner.create).toHaveBeenCalledOnce()
	})

	it('is the wrapped driver when no hooks exist at all', async () => {
		const inner = innerDriver()
		const driver = new HookedWorkspaceDriver({ inner, hooks: () => undefined, root: () => '/r' })
		await driver.create({})
		expect(inner.create).toHaveBeenCalledOnce()
	})

	it("uses the hook's folder, tells it the name and the root, and creates none itself", async () => {
		const root = scratch()
		const made = join(root, 'copy')
		mkdirSync(made)
		const inner = innerDriver()
		const hooks = host({ create: [{ action: 'continue', worktreePath: 'copy' }] })
		const driver = new HookedWorkspaceDriver({ inner, hooks, root: () => root })
		const ref = await driver.create({ label: 'copy', baseRef: 'abc' })
		expect(inner.create).not.toHaveBeenCalled()
		expect(ref.meta.worktreePath).toBe(made)
		expect(ref.meta.hookOwned).toBe(true)
		expect(hooks.calls[0]).toEqual([
			'worktree_create',
			{ worktreeName: 'copy', worktreeRoot: root, worktreeBaseRef: 'abc' },
		])
	})

	it('accepts an absolute folder anywhere', async () => {
		const elsewhere = scratch()
		const driver = new HookedWorkspaceDriver({
			inner: innerDriver(),
			hooks: host({ create: [{ action: 'continue', worktreePath: elsewhere }] }),
			root: () => '/nowhere',
		})
		expect((await driver.create({})).meta.worktreePath).toBe(elsewhere)
	})

	it('fails with the hook words when a hook failed, and never creates', async () => {
		const inner = innerDriver()
		const driver = new HookedWorkspaceDriver({
			inner,
			hooks: host({
				create: [{ action: 'error', message: 'The worktree_create hook `h` failed' }],
			}),
			root: () => '/r',
		})
		await expect(driver.create({})).rejects.toThrow('The worktree_create hook `h` failed')
		await expect(driver.create({})).rejects.toBeInstanceOf(WorktreeHookError)
		expect(inner.create).not.toHaveBeenCalled()
	})

	it('fails when hooks exist and none gave a path', async () => {
		const inner = innerDriver()
		const driver = new HookedWorkspaceDriver({
			inner,
			hooks: host({ create: [{ action: 'continue' }] }),
			root: () => '/r',
		})
		await expect(driver.create({})).rejects.toThrow('gave no worktree path')
		expect(inner.create).not.toHaveBeenCalled()
	})

	it('fails when the folder it gave does not exist', async () => {
		const root = scratch()
		const driver = new HookedWorkspaceDriver({
			inner: innerDriver(),
			hooks: host({ create: [{ action: 'continue', worktreePath: 'missing' }] }),
			root: () => root,
		})
		await expect(driver.create({})).rejects.toThrow('not a folder that exists')
	})

	it('one failing hook fails the creation even when another gave a path', async () => {
		const root = scratch()
		const driver = new HookedWorkspaceDriver({
			inner: innerDriver(),
			hooks: host({
				create: [
					{ action: 'continue', worktreePath: root },
					{ action: 'error', message: 'second failed' },
				],
			}),
			root: () => root,
		})
		await expect(driver.create({})).rejects.toThrow('second failed')
	})
})

describe('dispose', () => {
	it('is the wrapped driver for a kernel worktree when no remove hook is set', async () => {
		const inner = innerDriver()
		const driver = new HookedWorkspaceDriver({ inner, hooks: host({}), root: () => '/r' })
		await driver.dispose(kernelRef('/kernel'))
		expect(inner.dispose).toHaveBeenCalledOnce()
	})

	it('is left to the hook when one is set, and the kernel removes nothing', async () => {
		const inner = innerDriver()
		const hooks = host({ remove: [{ action: 'continue' }] })
		const driver = new HookedWorkspaceDriver({ inner, hooks, root: () => '/r' })
		await driver.dispose(kernelRef('/kernel'))
		expect(inner.dispose).not.toHaveBeenCalled()
		expect(hooks.calls[0]).toEqual(['worktree_remove', { worktreePath: '/kernel' }])
	})

	it('leaves a hook-made folder and says where when there is no remove hook', async () => {
		const root = scratch()
		const inner = innerDriver()
		const notices: string[] = []
		const driver = new HookedWorkspaceDriver({
			inner,
			hooks: host({ create: [{ action: 'continue', worktreePath: root }] }),
			root: () => root,
			onNotice: (line) => notices.push(line),
		})
		const ref = await driver.create({})
		await driver.dispose(ref)
		expect(inner.dispose).not.toHaveBeenCalled()
		expect(notices.join(' ')).toContain(root)
		expect(notices.join(' ')).toContain('left in place')
	})

	it('reports a failed remove hook, unless nothing is left at the path', async () => {
		const root = scratch()
		const there = join(root, 'there')
		mkdirSync(there)
		const failing = host({ remove: [{ action: 'error', message: 'rm.sh failed: busy' }] })
		const driver = new HookedWorkspaceDriver({
			inner: innerDriver(),
			hooks: failing,
			root: () => root,
		})
		await expect(driver.dispose(kernelRef(there))).rejects.toThrow('rm.sh failed: busy')
		await expect(driver.dispose(kernelRef(join(root, 'absent')))).resolves.toBeUndefined()
	})
})

describe('inspect and branch', () => {
	it('inspects a hook-made folder without Git: unchanged only when it looks as it did', async () => {
		const root = scratch()
		const inner = innerDriver()
		const driver = new HookedWorkspaceDriver({
			inner,
			hooks: host({ create: [{ action: 'continue', worktreePath: root }] }),
			root: () => root,
		})
		const ref = await driver.create({})
		const seen = await driver.inspect(ref)
		expect(seen.exists).toBe(true)
		// Looks as it did when the hook finished: unchanged.
		expect(seen).toMatchObject({ isDirty: false, hasNewCommits: false })
		writeFileSync(join(root, 'new.txt'), 'x')
		expect(await driver.inspect(ref)).toMatchObject({ isDirty: true, hasNewCommits: true })
		// A ref this driver did not see made reads as changed.
		const foreign = { ...ref, id: 'ws_other' as WorkspaceRef['id'] }
		expect(await driver.inspect(foreign)).toMatchObject({ hasNewCommits: true })
		expect(inner.inspect).not.toHaveBeenCalled()
		expect((await driver.inspect(kernelRef('/k'))).exists).toBe(true)
		expect(inner.inspect).toHaveBeenCalledOnce()
	})

	it('a branch goes through the create event', async () => {
		const root = scratch()
		const inner = innerDriver()
		const hooks = host({ create: [{ action: 'continue', worktreePath: root }] })
		const driver = new HookedWorkspaceDriver({ inner, hooks, root: () => root })
		await driver.branch(kernelRef('/k'), { label: 'b' })
		expect(inner.branch).not.toHaveBeenCalled()
		expect(hooks.calls[0]?.[1]).toMatchObject({ worktreeName: 'b', worktreeBaseRef: 'namzu/k' })
		const none = new HookedWorkspaceDriver({ inner, hooks: host({}), root: () => root })
		await none.branch(kernelRef('/k'), { label: 'b' })
		expect(inner.branch).toHaveBeenCalledOnce()
	})
})
