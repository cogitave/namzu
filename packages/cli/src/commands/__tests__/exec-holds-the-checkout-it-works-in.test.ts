import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DiskWorkspaceHoldStore, defaultWorktreesDir } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { fakeAgentSession } from '../../tui/__fixtures__/agent-session.js'
import { execCommand } from '../exec.js'
import type { CommandContext } from '../types.js'

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

/**
 * Who is working in the checkout, read from inside the run.
 *
 * It has to be read there: a holding written before the turn and removed after
 * it looks, from outside, exactly like one that was never written. The store is
 * the test's own, so the read is the same code the command itself would ask.
 */
const probe = vi.hoisted(() => ({
	checkout: '',
	read: undefined as undefined | ((path: string) => Promise<string[]>),
	heldDuringRun: [] as string[][],
}))

vi.mock('../../tui/agent.js', () => ({
	probeAgentSession: vi.fn(async () => ({
		preferences: { version: 2, provider: 'mock', subagents: { active: [] } },
		detected: [],
	})),
	createAgentSession: vi.fn(async () => {
		if (probe.read) probe.heldDuringRun.push(await probe.read(probe.checkout))
		return fakeAgentSession()
	}),
}))

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

/** A checkout where managed ones live, made the way `namzu worktree` makes one. */
function managedCheckout(): string {
	const root = mkdtempSync(join(tmpdir(), 'namzu-exec-holds-'))
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

function headlessContext(): CommandContext {
	return {
		formatter: { name: 'text' as const, print: () => {}, info: () => {}, error: () => {} },
		config: {},
		logging: { level: 'silent' as const, format: 'json' as const },
	} as unknown as CommandContext
}

it('holds the checkout a one-shot run works in, and lets go of it when the run ends', async () => {
	const checkout = managedCheckout()
	const store = new DiskWorkspaceHoldStore()
	probe.checkout = checkout
	probe.read = async (path) => (await store.holders(path)).map((held) => held.holder)
	probe.heldDuringRun.length = 0
	expect(await store.holders(checkout)).toEqual([])

	await execCommand.handler({
		ctx: headlessContext(),
		rawArgs: ['--cwd', checkout, 'hi'],
	})

	// Seen from inside the run: the folder this run works in says a session is
	// working in it, so a removal asked for elsewhere is refused instead of
	// taking the files this run has open.
	expect(probe.heldDuringRun).toEqual([[`session:${process.pid}`]])
	// And the holding goes with the run: the checkout is still there for whoever
	// wants it next, and nothing claims a process that is finished with it.
	expect(await store.holders(checkout)).toEqual([])
})

it('holds nothing when the run works in a folder that is not a managed checkout', async () => {
	const root = mkdtempSync(join(tmpdir(), 'namzu-exec-plain-'))
	roots.push(root)
	const store = new DiskWorkspaceHoldStore()
	probe.checkout = root
	probe.read = async (path) => (await store.holders(path)).map((held) => held.holder)
	probe.heldDuringRun.length = 0

	await execCommand.handler({ ctx: headlessContext(), rawArgs: ['--cwd', root, 'hi'] })

	expect(probe.heldDuringRun).toEqual([[]])
	expect(await store.holders(root)).toEqual([])
})
