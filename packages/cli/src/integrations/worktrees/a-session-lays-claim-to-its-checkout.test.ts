import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DiskWorkspaceHoldStore, defaultWorktreesDir } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { holdSessionCheckout, openManagedWorktrees } from './managed.js'

/**
 * A session started in a managed checkout says so for as long as it runs, and
 * that claim is what makes a removal from another process refuse instead of
 * deleting the checkout with the session's uncommitted files in it.
 *
 * The terminal and `namzu exec` both reach this through one call, so it is
 * checked here rather than twice, once through each command.
 */

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

/** A Git checkout with one managed worktree in it, as `namzu worktree` makes them. */
function managedCheckout(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-hold-claim-'))
	roots.push(root)
	const repo = join(root, 'main')
	mkdirSync(repo)
	git(repo, 'init', '--quiet')
	git(repo, 'config', 'user.name', 'Namzu Test')
	git(repo, 'config', 'user.email', 'namzu-test@example.invalid')
	writeFileSync(join(repo, 'base.txt'), 'base\n')
	git(repo, 'add', 'base.txt')
	git(repo, 'commit', '--quiet', '-m', 'base')
	const checkout = join(defaultWorktreesDir(repo), 'review')
	mkdirSync(dirname(checkout), { recursive: true })
	git(repo, 'worktree', 'add', '--quiet', '-b', 'namzu/review', checkout)
	return checkout
}

it('lays claim to the checkout a session is started in, until it lets go', async () => {
	const checkout = managedCheckout()
	const inside = join(checkout, 'packages', 'sdk')
	mkdirSync(inside, { recursive: true })
	const store = new DiskWorkspaceHoldStore()
	expect(await store.holders(checkout)).toEqual([])

	// Started in a folder below the checkout root, which is where a session in a
	// package directory sits: the claim is on the checkout, not on that folder.
	const release = await holdSessionCheckout(inside, 'session:1234')
	expect(release).toBeDefined()
	expect((await store.holders(checkout)).map((held) => held.holder)).toEqual(['session:1234'])

	await release?.()
	expect(await store.holders(checkout)).toEqual([])
})

it('writes its holding where the manager that removes it reads it, under a state root', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-hold-state-root-'))
	roots.push(root)
	const repo = join(root, 'main')
	mkdirSync(repo)
	git(repo, 'init', '--quiet')
	git(repo, 'config', 'user.name', 'Namzu Test')
	git(repo, 'config', 'user.email', 'namzu-test@example.invalid')
	writeFileSync(join(repo, 'base.txt'), 'base\n')
	git(repo, 'add', 'base.txt')
	git(repo, 'commit', '--quiet', '-m', 'base')
	const stateRoot = join(root, 'state')
	const manager = await openManagedWorktrees(repo, { stateRoot })
	const checkout = await manager.create('claim')

	// The holding and the removal share one state root, so the removal is refused
	// for the session that holds the checkout — not written to some other home.
	const release = await holdSessionCheckout(checkout.path, 'session:1234', { stateRoot })
	expect(release).toBeDefined()
	expect((await manager.holders('claim')).map((held) => held.holder)).toEqual(['session:1234'])
	expect(await new DiskWorkspaceHoldStore().holders(checkout.path)).toEqual([])

	await release?.()
	expect(await manager.holders('claim')).toEqual([])
})

it('lays claim to nothing when the session is started outside a managed checkout', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-hold-plain-'))
	roots.push(root)

	expect(await holdSessionCheckout(root, 'session:1234')).toBeUndefined()
	expect(await new DiskWorkspaceHoldStore().holders(root)).toEqual([])
})
