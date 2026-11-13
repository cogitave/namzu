/**
 * worktree_create and worktree_remove hooks in the managed-worktree layer: a
 * hook's folder is the worktree and Git makes none, a failing hook fails the
 * creation in its own words, a folder that is not a Git checkout works when a
 * hook can make it, and with no hook everything is Git's, as before.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginHookResult, WorktreeHookHost } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { DelegatedWorktreeDriver } from '../subagents/worktree-driver.js'
import { HOOK_MADE_BRANCH, openManagedWorktrees } from './managed.js'

const dirs: string[] = []
afterEach(() => {
	for (const root of dirs.splice(0)) removeTempDir(root)
})

function folder(git: boolean): { repo: string; stateRoot: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-managed-hooks-'))
	dirs.push(root)
	const repo = join(root, 'repo')
	const stateRoot = join(root, 'state')
	mkdirSync(repo)
	mkdirSync(stateRoot)
	writeFileSync(join(repo, 'tracked.txt'), 'committed\n')
	if (git) {
		const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args])
		run('init', '-q')
		run('add', 'tracked.txt')
		run('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'initial')
	}
	return { repo, stateRoot }
}

function host(
	answer: (event: string, context: Record<string, unknown>) => PluginHookResult[],
): WorktreeHookHost & { calls: [string, Record<string, unknown>][] } {
	const calls: [string, Record<string, unknown>][] = []
	return {
		calls,
		execute: async (event, context) => {
			calls.push([event, { ...context }])
			return answer(event, { ...context })
		},
	}
}

describe('a create hook in a Git checkout', () => {
	it("is the worktree, Git makes none, and Namzu's list does not show it", async () => {
		const { repo, stateRoot } = folder(true)
		const made: string[] = []
		const hooks = host((event, context) => {
			if (event !== 'worktree_create') return []
			const path = join(String(context.worktreeRoot), String(context.worktreeName))
			mkdirSync(path, { recursive: true })
			made.push(path)
			return [{ action: 'continue', worktreePath: path }]
		})
		const manager = await openManagedWorktrees(repo, { stateRoot, hooks: () => hooks })
		const created = await manager.create('copy-one')
		expect(created.path).toBe(made[0])
		expect(created.madeByHook).toBe(true)
		expect(created.branch).toBe(HOOK_MADE_BRANCH)
		expect(hooks.calls[0]?.[1]).toMatchObject({ worktreeName: 'copy-one' })
		expect(
			execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n'),
		).toHaveLength(1)
		expect(await manager.list()).toEqual([])
	})

	it('fails with the hook words and creates nothing when the hook fails', async () => {
		const { repo, stateRoot } = folder(true)
		const hooks = host(() => [{ action: 'error', message: 'The worktree_create hook `x` failed' }])
		const manager = await openManagedWorktrees(repo, { stateRoot, hooks: () => hooks })
		await expect(manager.create('copy-two')).rejects.toThrow('The worktree_create hook `x` failed')
		expect(
			execFileSync('git', ['-C', repo, 'worktree', 'list']).toString().trim().split('\n'),
		).toHaveLength(1)
		expect(existsSync(join(manager.worktreesDir, 'copy-two'))).toBe(false)
	})

	it('is Git when no hook answers the event', async () => {
		const { repo, stateRoot } = folder(true)
		const hooks = host(() => [])
		const manager = await openManagedWorktrees(repo, { stateRoot, hooks: () => hooks })
		const created = await manager.create('plain')
		expect(created.branch).toBe('namzu/plain')
		expect(created.madeByHook).not.toBe(true)
	})
})

describe('a folder that is not a Git checkout', () => {
	it('cannot be managed without a hook source, and says why', async () => {
		const { repo, stateRoot } = folder(false)
		await expect(openManagedWorktrees(repo, { stateRoot })).rejects.toThrow(
			'Cannot manage worktrees here',
		)
	})

	it('works when a hook makes the worktree, and says why when none does', async () => {
		const { repo, stateRoot } = folder(false)
		const made = host((event, context) => {
			if (event !== 'worktree_create') return []
			const path = join(String(context.worktreeRoot), String(context.worktreeName))
			mkdirSync(path, { recursive: true })
			return [{ action: 'continue', worktreePath: path }]
		})
		const manager = await openManagedWorktrees(repo, { stateRoot, hooks: () => made })
		const created = await manager.create('copy-three')
		expect(existsSync(created.path)).toBe(true)
		expect(made.calls[0]?.[1]).not.toHaveProperty('worktreeBaseRef')
		const silent = await openManagedWorktrees(repo, { stateRoot, hooks: () => host(() => []) })
		await expect(silent.create('nope')).rejects.toThrow('Cannot manage worktrees here')
	})
})

describe('a delegated child', () => {
	it('works in the hook-made folder, and a failed creation reaches the person', async () => {
		const { repo, stateRoot } = folder(false)
		const lines: string[] = []
		let fail = false
		const hooks = host((event, context) => {
			if (event !== 'worktree_create') return []
			if (fail) return [{ action: 'error', message: 'hook said no' }]
			const path = join(String(context.worktreeRoot), String(context.worktreeName))
			mkdirSync(path, { recursive: true })
			return [{ action: 'continue', worktreePath: path }]
		})
		const driver = new DelegatedWorktreeDriver(repo, stateRoot, {
			host: () => hooks,
			onNotice: (line) => lines.push(line),
		})
		const ref = await driver.create({ label: 'child-1' })
		expect(ref.meta.hookOwned).toBe(true)
		expect(existsSync(ref.meta.worktreePath)).toBe(true)
		// No remove hook: the folder is left, and the person is told where it is.
		await driver.dispose(ref)
		expect(existsSync(ref.meta.worktreePath)).toBe(true)
		expect(lines.join('\n')).toContain(ref.meta.worktreePath)
		fail = true
		await expect(driver.create({ label: 'child-2' })).rejects.toThrow('hook said no')
		expect(lines.at(-1)).toBe('hook said no')
	})
})
