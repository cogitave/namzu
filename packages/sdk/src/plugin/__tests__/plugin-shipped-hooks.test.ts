/**
 * Hook entries a plugin ships: the folders its commands are given, the lifecycle
 * that attaches them when the plugin is enabled and removes them when it is
 * disabled, and the manifest reading that keeps `hooks` a list of module paths.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PluginRegistry } from '../../registry/plugin/index.js'
import { PluginManifestSchema } from '../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { PluginLifecycleManager, isHookEntriesPath } from '../lifecycle.js'
import {
	isPluginFolderVariable,
	movedEnvironment,
	substitutePluginFolders,
} from '../shell-hook-env.js'
import { createShellHook, runShellHook } from '../shell-hook.js'

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'
const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-plugin-hooks-sdk-'))
	roots.push(dir)
	return dir
}

describe('the plugin folder variables', () => {
	const folders = { root: '/p/root', dataDir: '/h/data' }

	it('reads names by their ending', () => {
		expect(isPluginFolderVariable('NAMZU_PLUGIN_ROOT')).toBe(true)
		expect(isPluginFolderVariable('SOMETOOL_PLUGIN_DATA')).toBe(true)
		expect(isPluginFolderVariable('SOMETOOL_PLUGIN_ROOTS')).toBe(false)
		expect(isPluginFolderVariable('NAMZU_PROJECT_DIR')).toBe(false)
	})

	it('puts the folders in text, braced or bare, and leaves modifiers and other names', () => {
		expect(
			substitutePluginFolders(
				'${NAMZU_PLUGIN_ROOT}/a $NAMZU_PLUGIN_DATA/b ${X_PLUGIN_ROOT}',
				folders,
			),
		).toBe('/p/root/a /h/data/b /p/root')
		expect(
			substitutePluginFolders('${NAMZU_PLUGIN_ROOT:-x} $HOME $NAMZU_PROJECT_DIR', folders),
		).toBe('${NAMZU_PLUGIN_ROOT:-x} $HOME $NAMZU_PROJECT_DIR')
		expect(substitutePluginFolders('${NAMZU_PLUGIN_ROOT}', undefined)).toBe('${NAMZU_PLUGIN_ROOT}')
	})

	it('fills an unset name by its ending only when the entry has a plugin to give', () => {
		const entry = { command: '"$ACME_PLUGIN_ROOT"/x "$ACME_PLUGIN_DATA"' }
		const withPlugin = movedEnvironment(
			entry,
			{ PATH: '/bin' },
			{},
			{
				project: '/proj',
				plugin: '/p/root',
				pluginData: '/h/data',
			},
		)
		expect(withPlugin.env.ACME_PLUGIN_ROOT).toBe('/p/root')
		expect(withPlugin.env.ACME_PLUGIN_DATA).toBe('/h/data')
		expect(withPlugin.unset).toEqual([])
		const without = movedEnvironment(entry, { PATH: '/bin' }, {}, { project: '/proj' })
		expect(without.env.ACME_PLUGIN_ROOT).toBeUndefined()
		expect(without.unset).toEqual(['ACME_PLUGIN_ROOT', 'ACME_PLUGIN_DATA'])
	})
})

describe('running an entry a plugin ships', () => {
	const input = (root: string, dataDir: string) =>
		({
			event: 'turn_start',
			sessionId: SESSION,
			cwd: root,
			plugin: { root, dataDir },
		}) as const

	it('starts the command with its own folder and data folder, and creates the data folder', async () => {
		const base = scratch()
		const root = join(base, 'plugin')
		const dataDir = join(base, 'home', 'plugin-data', 'demo')
		mkdirSync(root)
		expect(existsSync(dataDir)).toBe(false)
		const outcome = await runShellHook(
			{ command: 'printf "%s|%s" "$NAMZU_PLUGIN_ROOT" "${NAMZU_PLUGIN_DATA}"' },
			input(root, dataDir),
		)
		expect(outcome.exitCode).toBe(0)
		expect(outcome.stdout).toBe(`${root}|${dataDir}`)
		expect(existsSync(dataDir)).toBe(true)
	})

	it('puts the folder in the arguments of an exec form, which no shell reads', async () => {
		const base = scratch()
		const root = join(base, 'a plugin with spaces')
		mkdirSync(root)
		writeFileSync(join(root, 'note.txt'), 'hello from the plugin')
		const outcome = await runShellHook(
			{ command: 'cat', args: ['${NAMZU_PLUGIN_ROOT}/note.txt'] },
			input(root, join(base, 'data')),
		)
		expect(outcome.stdout).toBe('hello from the plugin')
	})

	it('puts the folder in the command text of the exec form too', async () => {
		const base = scratch()
		const root = join(base, 'plugin')
		mkdirSync(join(root, 'bin'), { recursive: true })
		writeFileSync(join(root, 'bin', 'say.sh'), '#!/bin/sh\nprintf said\n', { mode: 0o755 })
		const outcome = await runShellHook(
			{ command: '${NAMZU_PLUGIN_ROOT}/bin/say.sh', args: [] },
			input(root, join(base, 'data')),
		)
		expect(outcome.stdout).toBe('said')
	})

	it('finds its folder by the shape of a name written for another tool', async () => {
		const base = scratch()
		const root = join(base, 'plugin')
		mkdirSync(root)
		const outcome = await runShellHook(
			{ command: 'printf %s "$OTHERTOOL_PLUGIN_ROOT"' },
			input(root, join(base, 'data')),
		)
		expect(outcome.stdout).toBe(root)
	})

	it('does not run a command that names a plugin folder when no plugin gives one', async () => {
		const base = scratch()
		const marker = join(base, 'ran')
		const outcome = await runShellHook(
			{ command: `touch ${marker}; "$NAMZU_PLUGIN_ROOT/guard.sh"` },
			{ event: 'turn_start', sessionId: SESSION, cwd: base },
		)
		expect(outcome.exitCode).toBeNull()
		expect(outcome.spawnError).toMatch(/NAMZU_PLUGIN_ROOT.*only a hook entry a plugin ships/)
		expect(existsSync(marker)).toBe(false)
	})

	it('runs it when the person gave the variable themselves', async () => {
		const base = scratch()
		const outcome = await runShellHook(
			{ command: 'printf %s "$NAMZU_PLUGIN_ROOT"', env: { NAMZU_PLUGIN_ROOT: '/given' } },
			{ event: 'turn_start', sessionId: SESSION, cwd: base },
		)
		expect(outcome.stdout).toBe('/given')
	})

	it('names a data folder it cannot create, and does not start the command', async () => {
		const base = scratch()
		const blocker = join(base, 'blocker')
		writeFileSync(blocker, 'a file')
		const outcome = await runShellHook({ command: 'true' }, input(base, join(blocker, 'inside')))
		expect(outcome.exitCode).toBeNull()
		expect(outcome.spawnError).toMatch(/data folder could not be created/)
	})

	it('reaches the command through createShellHook options', async () => {
		const base = scratch()
		const root = join(base, 'plugin')
		const out = join(base, 'out.txt')
		mkdirSync(root)
		const hook = createShellHook(
			'turn_start',
			{ command: `printf %s "$NAMZU_PLUGIN_ROOT" > ${out}` },
			{ cwd: base, plugin: { root, dataDir: join(base, 'data') } },
		)
		await hook.handler({ pluginId: 'x', event: 'turn_start', sessionId: SESSION } as never)
		expect(readFileSync(out, 'utf8')).toBe(root)
	})
})

describe('a manifest that ships hook entries', () => {
	const base = { name: 'demo', version: '1.0.0', description: 'Demo' }

	it('keeps `hooks` a list of paths and keeps inline entries as written', () => {
		const parsed = PluginManifestSchema.parse({
			...base,
			hooks: ['hooks/extra.json', 'hooks.mjs'],
			hookEntries: {
				PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
			},
		})
		expect(parsed.hooks).toEqual(['hooks/extra.json', 'hooks.mjs'])
		expect(parsed.hookEntries).toEqual({
			PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }],
		})
	})

	it('still refuses `hooks` that is not a list of text', () => {
		expect(() => PluginManifestSchema.parse({ ...base, hooks: { PreToolUse: [] } })).toThrow()
		expect(() => PluginManifestSchema.parse({ ...base, hookEntries: ['x'] })).toThrow()
	})

	it('tells an entries file from a module by its ending', () => {
		expect(isHookEntriesPath('hooks/hooks.json')).toBe(true)
		expect(isHookEntriesPath('X.JSON')).toBe(true)
		expect(isHookEntriesPath('hooks.mjs')).toBe(false)
	})
})

describe('the entries live as long as the plugin is on', () => {
	function folder(manifest: Record<string, unknown>): { root: string; dir: string } {
		const root = scratch()
		const dir = join(root, 'plugin')
		mkdirSync(dir)
		writeFileSync(
			join(dir, 'plugin.json'),
			JSON.stringify({ name: 'demo', version: '1.0.0', description: 'Demo', ...manifest }),
		)
		return { root, dir }
	}

	function manager(root: string, calls: string[]): PluginLifecycleManager {
		return new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			scopeRoots: { project: root, user: root },
			log: NOOP_LOGGER,
			hooksFor: (plugin) => {
				calls.push(`${plugin.manifest.name}@${plugin.rootDir}`)
				return [
					createShellHook('turn_start', { command: 'true' }, { cwd: root }),
					createShellHook('turn_end', { command: 'true' }, { cwd: root }),
				]
			},
		})
	}

	it('attaches them on enable, lists them as read from entries, and removes them on disable', async () => {
		const { root, dir } = folder({ hooks: ['hooks/hooks.json'] })
		const calls: string[] = []
		const m = manager(root, calls)
		const plugin = await m.install(dir, 'project')
		expect(m.listHooks()).toEqual([])
		expect(calls).toEqual([])
		await m.enable(plugin.id)
		expect(calls).toHaveLength(1)
		expect(m.listHooks()).toEqual([
			{ pluginId: plugin.id, event: 'turn_start', shell: true },
			{ pluginId: plugin.id, event: 'turn_end', shell: true },
		])
		await m.disable(plugin.id)
		expect(m.listHooks()).toEqual([])
		// Enabled again: attached once more, not twice.
		await m.enable(plugin.id)
		expect(m.listHooks()).toHaveLength(2)
		expect(calls).toHaveLength(2)
	})

	it('does not attach a second time when the plugin is enabled twice', async () => {
		const { root, dir } = folder({})
		const calls: string[] = []
		const m = manager(root, calls)
		const plugin = await m.install(dir, 'project')
		await m.enable(plugin.id)
		await expect(m.enable(plugin.id)).rejects.toThrow(/status is "enabled"/)
		expect(m.listHooks()).toHaveLength(2)
	})

	it('does not import a `.json` path in `hooks` as a module', async () => {
		const { root, dir } = folder({ hooks: ['hooks/hooks.json', 'mod.mjs'] })
		writeFileSync(
			join(dir, 'mod.mjs'),
			'export const hooks = [{ event: "turn_start", handler: async () => ({ action: "continue" }) }]\n',
		)
		mkdirSync(join(dir, 'hooks'))
		writeFileSync(join(dir, 'hooks', 'hooks.json'), '{ "not": "a module" }')
		const m = manager(root, [])
		const plugin = await m.install(dir, 'project')
		await m.enable(plugin.id)
		const own = m.listHooks().filter((hook) => hook.shell !== true)
		expect(own).toEqual([{ pluginId: plugin.id, event: 'turn_start' }])
	})

	it('rolls the entries back with the rest when the enable fails', async () => {
		const { root, dir } = folder({ hooks: ['missing.mjs'] })
		const m = manager(root, [])
		const plugin = await m.install(dir, 'project')
		await expect(m.enable(plugin.id)).rejects.toThrow()
		expect(m.listHooks()).toEqual([])
	})

	it('removes them when the plugin is uninstalled', async () => {
		const { root, dir } = folder({})
		const m = manager(root, [])
		const plugin = await m.install(dir, 'project')
		await m.enable(plugin.id)
		await m.uninstall(plugin.id)
		expect(m.listHooks()).toEqual([])
	})
})
