import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { PluginRegistry } from '../../registry/plugin/index.js'
import { PluginManifestSchema } from '../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'

const base = { name: 'demo', version: '1.0.0', description: 'Demo' }

describe('command and agent folders in a manifest', () => {
	it('keeps the folders a plugin declares', () => {
		const parsed = PluginManifestSchema.parse({
			...base,
			commands: ['commands'],
			agents: ['agents', 'more/agents'],
		})
		expect(parsed.commands).toEqual(['commands'])
		expect(parsed.agents).toEqual(['agents', 'more/agents'])
	})

	it.each(['../outside', 'a/../../b', '/etc', 'C:\\Users', '\\share'])(
		'refuses %s, which is not a folder inside the plugin',
		(dir) => {
			expect(() => PluginManifestSchema.parse({ ...base, commands: [dir] })).toThrow(
				/inside the plugin/,
			)
			expect(() => PluginManifestSchema.parse({ ...base, agents: [dir] })).toThrow(
				/inside the plugin/,
			)
		},
	)
})

describe('installing a plugin that is its own authority', () => {
	const dirs: string[] = []
	afterEach(async () => {
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
	})

	async function plugin(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-plugin-authority-'))
		dirs.push(dir)
		await mkdir(join(dir, 'p'))
		await writeFile(
			join(dir, 'p', 'plugin.json'),
			JSON.stringify({ ...base, commands: ['commands'] }),
		)
		return join(dir, 'p')
	}

	function manager(scopeRoot: string): PluginLifecycleManager {
		return new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			scopeRoots: { project: scopeRoot, user: scopeRoot },
			log: NOOP_LOGGER,
		})
	}

	it('refuses a folder outside the scope root', async () => {
		const pluginDir = await plugin()
		const elsewhere = await mkdtemp(join(tmpdir(), 'namzu-plugin-scope-'))
		dirs.push(elsewhere)
		await expect(manager(elsewhere).install(pluginDir, 'user')).rejects.toThrow(/escapes/)
	})

	it('admits it when the folder names itself as the authority, and carries the folders', async () => {
		const pluginDir = await plugin()
		const elsewhere = await mkdtemp(join(tmpdir(), 'namzu-plugin-scope-'))
		dirs.push(elsewhere)
		const installed = await manager(elsewhere).install(pluginDir, 'user', {
			authorityRoot: pluginDir,
		})
		expect(installed.manifest.commands).toEqual(['commands'])
		expect(installed.status).toBe('installed')
	})
})
