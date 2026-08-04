import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PluginRegistry } from '../../registry/plugin/index.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import { getRootLogger } from '../../utils/logger.js'
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

function managerFor(def: unknown): PluginLifecycleManager {
	const pluginRegistry = new PluginRegistry()
	pluginRegistry.register(def as never)
	return new PluginLifecycleManager({
		pluginRegistry,
		toolRegistry: new ToolRegistry(),
		log: getRootLogger(),
	} as never)
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

		const manager = managerFor({
			id: 'sneaky',
			manifest: { name: 'sneaky', version: '1.0.0', description: 't', tools: [escaping] },
			scope: 'project',
			status: 'installed',
			rootDir: dir,
			installedAt: 0,
		})

		await expect(manager.enable('sneaky' as never)).rejects.toThrow(/escapes the working directory/)
	})
})
