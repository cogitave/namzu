/**
 * The hook runtime a command with no conversation opens for `worktree_create`
 * and `worktree_remove`: a hook entry a plugin ships takes over like one from
 * a config file, and the switches stop it as they stop every other hook.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { resetHookConfigProblems } from '../../config/load.js'
import { openWorktreeHookRuntime } from './hook-host.js'

const roots: string[] = []
afterEach(() => {
	resetHookConfigProblems()
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function pluginShippingAWorktreeHook(): Promise<{ root: string; plugin: string }> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-worktree-plugin-'))
	roots.push(root)
	const plugin = join(root, 'wt-plugin')
	await mkdir(join(plugin, 'hooks'), { recursive: true })
	await writeFile(
		join(plugin, 'plugin.json'),
		JSON.stringify({ name: 'wt-plugin', version: '1.0.0', description: 'ships a worktree hook' }),
	)
	await writeFile(
		join(plugin, 'hooks', 'hooks.json'),
		JSON.stringify({
			hooks: { worktree_create: [{ command: `printf '%s\\n' ${JSON.stringify(root)}` }] },
		}),
	)
	return { root, plugin }
}

describe('openWorktreeHookRuntime', () => {
	it('takes over with a hook entry a plugin ships', async () => {
		const { root, plugin } = await pluginShippingAWorktreeHook()
		const runtime = await openWorktreeHookRuntime(
			{ plugins: { enabled: false, launchDirs: [plugin] } },
			root,
			() => undefined,
		)
		try {
			const answers = await runtime.hooks?.host()?.execute('worktree_create', {
				worktreeName: 'w',
				worktreeRoot: root,
			})
			expect(answers?.length).toBe(1)
		} finally {
			await runtime.close()
		}
	})

	it('leaves it off under disableHooks and under hooksManagedOnly', async () => {
		const { root, plugin } = await pluginShippingAWorktreeHook()
		for (const switches of [{ disableHooks: true }, { hooksManagedOnly: true }]) {
			const runtime = await openWorktreeHookRuntime(
				{ plugins: { enabled: false, launchDirs: [plugin] }, ...switches },
				root,
				() => undefined,
			)
			try {
				const answers = await runtime.hooks?.host()?.execute('worktree_create', {
					worktreeName: 'w',
					worktreeRoot: root,
				})
				expect(answers ?? []).toEqual([])
			} finally {
				await runtime.close()
			}
		}
	})
})
