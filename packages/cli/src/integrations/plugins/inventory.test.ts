import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { readPluginInventory } from './inventory.js'
import type { CliPluginInfo } from './runtime.js'
import { PluginSettingsStore } from './settings.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-plugin-inventory-'))
	roots.push(root)
	const cwd = join(root, 'project')
	const userRoot = join(root, 'user')
	await mkdir(cwd)
	await mkdir(userRoot)
	return { root, cwd, userRoot }
}

async function plugin(root: string, name: string) {
	await mkdir(root, { recursive: true })
	await writeFile(
		join(root, 'plugin.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			description: 'Inventory fixture',
			tools: ['must-not-import.mjs'],
			mcpServers: [
				{
					name: 'private-server',
					command: 'node',
					env: { SECRET: 'must-not-leak' },
				},
			],
		}),
	)
	await writeFile(
		join(root, 'must-not-import.mjs'),
		'throw new Error("Inventory imported executable code");',
	)
}

it('does not discover plugins while executable plugins or discovery are off', async () => {
	for (const config of [
		undefined,
		{},
		{ enabled: false },
		{ enabled: true, autoDiscovery: false },
	]) {
		const view = await readPluginInventory({
			cwd: '/not/a/project',
			userRoot: '/not/a/user',
			config,
		})
		expect(view).toMatchObject({ plugins: [], live: false, canChange: false })
		expect(view.notice).toContain('off')
	}
})

it('reads admitted installed manifests and saved state without executing modules or leaking MCP secrets', async () => {
	const { cwd, userRoot } = await fixture()
	const pluginRoot = join(cwd, '.namzu', 'plugins', 'ledger')
	await plugin(pluginRoot, 'ledger')
	new PluginSettingsStore(userRoot).write({ rootDir: pluginRoot, name: 'ledger' }, false)
	const view = await readPluginInventory({ cwd, userRoot, config: { enabled: true } })
	expect(view).toMatchObject({
		live: false,
		canChange: false,
		plugins: [
			{
				name: 'ledger',
				version: '1.0.0',
				description: 'Inventory fixture',
				scope: 'project',
				status: 'installed',
				startupEnabled: false,
			},
		],
	})
	const serialized = JSON.stringify(view)
	for (const secret of ['must-not-leak', 'SECRET', 'private-server', 'must-not-import.mjs'])
		expect(serialized).not.toContain(secret)
	await expect(readFile(join(userRoot, 'imported.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('respects allowed locations and refuses a linked scope escaping its project root', async () => {
	const { root, cwd, userRoot } = await fixture()
	await plugin(join(userRoot, 'plugins', 'user-plugin'), 'user-plugin')
	await plugin(join(root, 'outside', 'plugins', 'outside-plugin'), 'outside-plugin')
	await symlink(join(root, 'outside'), join(cwd, '.namzu'), 'dir')
	const view = await readPluginInventory({
		cwd,
		userRoot,
		config: { enabled: true, allowedScopes: ['project'] },
	})
	expect(view.plugins).toEqual([])
	expect(
		(
			await readPluginInventory({
				cwd,
				userRoot,
				config: { enabled: true, allowedScopes: ['user'] },
			})
		).plugins.map((item) => item.name),
	).toEqual(['user-plugin'])
})

it('reports invalid manifests as unavailable rather than installed or enabled', async () => {
	const { cwd, userRoot } = await fixture()
	const pluginRoot = join(cwd, '.namzu', 'plugins', 'broken')
	await mkdir(pluginRoot, { recursive: true })
	await writeFile(join(pluginRoot, 'plugin.json'), '{"SECRET":"must-not-leak",malformed')
	const view = await readPluginInventory({ cwd, userRoot, config: { enabled: true } })
	expect(view.plugins).toHaveLength(1)
	expect(view.plugins[0]).toMatchObject({ name: 'broken', status: 'error' })
	expect(view.plugins[0]?.startupEnabled).toBeUndefined()
	expect(view.canChange).toBe(false)
	expect(JSON.stringify(view)).not.toContain('must-not-leak')
})

it('keeps detailed settings read failures off the outgoing installed inventory', async () => {
	const { cwd, userRoot } = await fixture()
	await plugin(join(cwd, '.namzu', 'plugins', 'ledger'), 'ledger')
	const error = new Error('Saved settings contain SYNTHETIC_PRIVATE_TOKEN')
	const read = vi.spyOn(PluginSettingsStore.prototype, 'read').mockImplementation(() => {
		throw error
	})
	try {
		const view = await readPluginInventory({ cwd, userRoot, config: { enabled: true } })
		expect(view.plugins).toMatchObject([
			{
				name: 'ledger',
				status: 'error',
				startupError: 'This plugin’s saved startup settings could not be read.',
			},
		])
		expect(view.plugins[0]?.startupEnabled).toBeUndefined()
		expect(JSON.stringify(view)).not.toContain('SYNTHETIC_PRIVATE_TOKEN')
		expect(error.message).toContain('SYNTHETIC_PRIVATE_TOKEN')
	} finally {
		read.mockRestore()
	}
})

it('uses the exact live runtime and keeps its current and next-start state distinct', async () => {
	const list = vi.fn((): CliPluginInfo[] => [
		{
			name: 'ledger',
			version: '1.0.0',
			description: 'Live plugin',
			scope: 'project',
			rootDir: '/private/plugin',
			status: 'enabled',
			startupEnabled: false,
			startupError: 'Initialization returned SYNTHETIC_PRIVATE_TOKEN',
			tools: ['privateTool'],
			skills: [],
			hookModules: ['hook.mjs'],
			mcpServers: ['secret-server'],
		},
	])
	const view = await readPluginInventory({ cwd: '/not/read', runtime: { list }, canChange: true })
	expect(list).toHaveBeenCalledOnce()
	expect(view).toMatchObject({
		live: true,
		canChange: true,
		plugins: [{ status: 'enabled', startupEnabled: false }],
	})
	expect(JSON.stringify(view)).not.toContain('/private/plugin')
	expect(JSON.stringify(view)).not.toContain('privateTool')
	expect(view.plugins[0]?.startupError).toBe('This plugin’s startup state could not be checked.')
	expect(JSON.stringify(view)).not.toContain('SYNTHETIC_PRIVATE_TOKEN')
	expect(list.mock.results[0]?.value[0]?.startupError).toContain('SYNTHETIC_PRIVATE_TOKEN')
})
