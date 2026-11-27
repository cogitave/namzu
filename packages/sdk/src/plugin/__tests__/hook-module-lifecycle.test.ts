/**
 * A hooks module lives as long as its plugin is on: attached when the plugin
 * is enabled, ended when it is disabled, uninstalled or rolled back.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PluginRegistry } from '../../registry/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import { createShellHook } from '../shell-hook.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function folder(manifest: Record<string, unknown> = {}): { root: string; dir: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-hmod-life-'))
	roots.push(root)
	const dir = join(root, 'plugin')
	mkdirSync(dir)
	writeFileSync(
		join(dir, 'plugin.json'),
		JSON.stringify({ name: 'demo', version: '1.0.0', description: 'Demo', ...manifest }),
	)
	return { root, dir }
}

function manager(root: string, started: { dispose: () => void }[], fail = false) {
	return new PluginLifecycleManager({
		pluginRegistry: new PluginRegistry(),
		scopeRoots: { project: root, user: root },
		log: NOOP_LOGGER,
		hookModuleFor: () => {
			const dispose = vi.fn()
			started.push({ dispose })
			return {
				hooks: [createShellHook('turn_end', { command: 'true' }, { cwd: root })],
				dispose,
			}
		},
		...(fail
			? {
					hooksFor: () => {
						throw new Error('entries broke')
					},
				}
			: {}),
	})
}

describe('a hooks module and the plugin lifecycle', () => {
	it('attaches the module hooks on enable and ends the module on disable and on uninstall', async () => {
		const { root, dir } = folder()
		const started: { dispose: ReturnType<typeof vi.fn> }[] = []
		const m = manager(root, started as never)
		const plugin = await m.install(dir, 'project')
		expect(started).toHaveLength(0)
		await m.enable(plugin.id)
		expect(m.listHooks().map((hook) => hook.event)).toEqual(['turn_end'])
		expect(started[0]?.dispose).not.toHaveBeenCalled()
		await m.disable(plugin.id)
		expect(started[0]?.dispose).toHaveBeenCalledTimes(1)
		expect(m.listHooks()).toEqual([])
		await m.enable(plugin.id)
		expect(started).toHaveLength(2)
		await m.uninstall(plugin.id)
		expect(started[1]?.dispose).toHaveBeenCalledTimes(1)
	})

	it('ends the module when a later part of the enable fails and is rolled back', async () => {
		const { root, dir } = folder({
			mcpServers: [{ name: 'gone', command: '/nonexistent/no-such-program' }],
		})
		const started: { dispose: ReturnType<typeof vi.fn> }[] = []
		const m = manager(root, started as never)
		const plugin = await m.install(dir, 'project')
		await expect(m.enable(plugin.id)).rejects.toThrow()
		expect(started).toHaveLength(1)
		expect(started[0]?.dispose).toHaveBeenCalledTimes(1)
		expect(m.listHooks()).toEqual([])
	})
})
