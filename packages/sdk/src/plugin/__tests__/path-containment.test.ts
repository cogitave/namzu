import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PluginRegistry } from '../../registry/plugin/index.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import { discoverPlugins } from '../loader.js'

/**
 * The plugin subsystem loads THIRD-PARTY code, which makes it the worst place
 * in this repo to be missing the containment its filesystem tools got this
 * week. It had none: zero `lstat`, zero `isSymbolicLink`, zero `resolveWithin`
 * across the loader and the lifecycle manager.
 *
 * Two holes, and the second is the serious one.
 *
 * `discoverPlugins` used `stat`, which follows a link and reports on its
 * TARGET — so a symlinked entry pointing anywhere on disk was admitted as a
 * plugin directory. The directory listed was not the directory loaded.
 *
 * And `PluginLifecycleManager` built its import path with
 * `join(plugin.rootDir, toolPath)` where `toolPath` comes out of the
 * MANIFEST — a file the plugin author writes. `"tools": ["../../../evil.js"]`
 * left the plugin directory entirely and was imported, which runs it.
 */

const CAN_SYMLINK = (() => {
	try {
		const probe = mkdtempSync(join(tmpdir(), 'namzu-plug-sym-'))
		symlinkSync(probe, join(probe, 'self'), 'dir')
		return true
	} catch {
		return false
	}
})()

const OUTSIDE_PLUGIN_MARKER = '__namzuOutsidePluginWasImported'

function pluginsDir(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-plugins-'))
}

function writePlugin(parent: string, name: string, manifest: Record<string, unknown>): string {
	const dir = join(parent, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'plugin.json'),
		JSON.stringify({ name, version: '1.0.0', description: 'test', ...manifest }),
	)
	return dir
}

describe('plugin discovery refuses a symlinked directory', () => {
	it.skipIf(!CAN_SYMLINK)('does not admit a link as a plugin directory', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'namzu-outside-'))
		writePlugin(outside, 'evil', { tools: [] })

		const parent = pluginsDir()
		writePlugin(parent, 'honest', { tools: [] })
		symlinkSync(join(outside, 'evil'), join(parent, 'linked'), 'dir')

		const found = await discoverPlugins(parent)

		expect(found.map((p) => p.split(/[\\/]/).pop())).toEqual(['honest'])
	})

	it('still finds an ordinary plugin directory', async () => {
		const parent = pluginsDir()
		writePlugin(parent, 'ordinary', { tools: [] })

		expect(await discoverPlugins(parent)).toHaveLength(1)
	})
})

describe('plugin installation stays inside its declared authority root', () => {
	it.skipIf(!CAN_SYMLINK)(
		'refuses an ordinary plugin reached through an intermediate symlink',
		async () => {
			const trusted = pluginsDir()
			const outside = pluginsDir()
			const plugin = writePlugin(join(outside, 'plugins'), 'outside-plugin', {
				hooks: ['hooks.mjs'],
			})
			writeFileSync(
				join(plugin, 'hooks.mjs'),
				`globalThis.${OUTSIDE_PLUGIN_MARKER} = true; export const hooks = [];\n`,
			)
			symlinkSync(outside, join(trusted, 'alias'), 'dir')
			const candidate = join(trusted, 'alias', 'plugins', 'outside-plugin')
			const pluginRegistry = new PluginRegistry()
			const manager = new PluginLifecycleManager({
				pluginRegistry,
				toolRegistry: new ToolRegistry(),
				scopeRoots: { project: trusted, user: trusted },
				log: NOOP_LOGGER,
			})
			let refusal: unknown

			try {
				const installed = await manager.install(candidate, 'project')
				await manager.enable(installed.id)
			} catch (error) {
				refusal = error
			}

			try {
				expect(refusal).toBeInstanceOf(Error)
				expect(String(refusal)).toMatch(/escapes|outside|authority/i)
				expect((globalThis as Record<string, unknown>)[OUTSIDE_PLUGIN_MARKER]).toBeUndefined()
				expect(pluginRegistry.getAll()).toEqual([])
			} finally {
				delete (globalThis as Record<string, unknown>)[OUTSIDE_PLUGIN_MARKER]
			}
		},
	)

	it.skipIf(!CAN_SYMLINK)(
		'refuses a symlinked manifest before registering the plugin',
		async () => {
			const trusted = pluginsDir()
			const plugin = join(trusted, 'linked-manifest')
			mkdirSync(plugin, { recursive: true })
			const manifest = join(trusted, 'manifest.json')
			writeFileSync(
				manifest,
				JSON.stringify({
					name: 'linked-manifest',
					version: '1.0.0',
					description: 'must not be followed',
				}),
			)
			symlinkSync(manifest, join(plugin, 'plugin.json'), 'file')
			const pluginRegistry = new PluginRegistry()
			const manager = new PluginLifecycleManager({
				pluginRegistry,
				toolRegistry: new ToolRegistry(),
				scopeRoots: { project: trusted, user: trusted },
				log: NOOP_LOGGER,
			})

			await expect(manager.install(plugin, 'project')).rejects.toThrow(/manifest|symlink/i)
			expect(pluginRegistry.getAll()).toEqual([])
		},
	)

	it.skipIf(!CAN_SYMLINK)(
		're-admits a direct registry record before executable contributions can load',
		async () => {
			const trusted = pluginsDir()
			const outside = pluginsDir()
			const plugin = writePlugin(outside, 'direct-outside', {
				hooks: ['hooks.mjs'],
			})
			writeFileSync(
				join(plugin, 'hooks.mjs'),
				`globalThis.${OUTSIDE_PLUGIN_MARKER} = true; export const hooks = [];\n`,
			)
			const pluginRegistry = new PluginRegistry()
			pluginRegistry.register({
				id: 'direct-outside' as never,
				manifest: {
					name: 'direct-outside',
					version: '1.0.0',
					description: 'forged installed record',
					hooks: ['hooks.mjs'],
				},
				scope: 'project',
				status: 'installed',
				rootDir: plugin,
				installedAt: 0,
			})
			const manager = new PluginLifecycleManager({
				pluginRegistry,
				toolRegistry: new ToolRegistry(),
				scopeRoots: { project: trusted, user: trusted },
				log: NOOP_LOGGER,
			})

			try {
				await expect(manager.enable('direct-outside' as never)).rejects.toThrow(
					/escapes|outside|authority/i,
				)
				expect((globalThis as Record<string, unknown>)[OUTSIDE_PLUGIN_MARKER]).toBeUndefined()
			} finally {
				delete (globalThis as Record<string, unknown>)[OUTSIDE_PLUGIN_MARKER]
			}
		},
	)

	it('does not let a mutable registry replace a manager-admitted root or manifest', async () => {
		const trusted = pluginsDir()
		const safe = writePlugin(trusted, 'safe-plugin', {})
		const outside = pluginsDir()
		const replacement = writePlugin(outside, 'replacement', {
			hooks: ['hooks.mjs'],
		})
		writeFileSync(
			join(replacement, 'hooks.mjs'),
			`globalThis.${OUTSIDE_PLUGIN_MARKER} = true; export const hooks = [];\n`,
		)
		const pluginRegistry = new PluginRegistry()
		const manager = new PluginLifecycleManager({
			pluginRegistry,
			toolRegistry: new ToolRegistry(),
			scopeRoots: { project: trusted, user: trusted },
			log: NOOP_LOGGER,
		})
		const installed = await manager.install(safe, 'project')
		pluginRegistry.register({
			...installed,
			manifest: {
				name: 'replacement',
				version: '1.0.0',
				description: 'registry overwrite',
				hooks: ['hooks.mjs'],
			},
			rootDir: replacement,
		})

		try {
			await manager.enable(installed.id)
			expect((globalThis as Record<string, unknown>)[OUTSIDE_PLUGIN_MARKER]).toBeUndefined()
			expect(pluginRegistry.getOrThrow(installed.id)).toMatchObject({
				manifest: { name: 'safe-plugin' },
				rootDir: safe,
				status: 'enabled',
			})
		} finally {
			delete (globalThis as Record<string, unknown>)[OUTSIDE_PLUGIN_MARKER]
		}
	})
})

function managerFor(def: unknown, authorityRoot: string): PluginLifecycleManager {
	const pluginRegistry = new PluginRegistry()
	pluginRegistry.register(def as never)
	return new PluginLifecycleManager({
		pluginRegistry,
		toolRegistry: new ToolRegistry(),
		scopeRoots: { project: authorityRoot, user: authorityRoot },
		log: NOOP_LOGGER,
	})
}

describe('a manifest cannot name a file outside its own plugin', () => {
	it('refuses a tool path that climbs out', async () => {
		// The manifest is written by the plugin author. Without containment the
		// named file was imported — which is to say, executed.
		const outside = mkdtempSync(join(tmpdir(), 'namzu-outside-'))
		writeFileSync(join(outside, 'evil.js'), 'export const tools = []')
		const parent = pluginsDir()
		const escaping = join('..', outside.split(/[\/]/).pop() as string, 'evil.js')
		const dir = writePlugin(parent, 'sneaky', { tools: [escaping] })

		const manager = managerFor(
			{
				id: 'sneaky',
				manifest: {
					name: 'sneaky',
					version: '1.0.0',
					description: 't',
					tools: [escaping],
				},
				scope: 'project',
				status: 'installed',
				rootDir: dir,
				installedAt: 0,
			},
			parent,
		)

		await expect(manager.enable('sneaky' as never)).rejects.toThrow(/escapes the working directory/)
	})
})
