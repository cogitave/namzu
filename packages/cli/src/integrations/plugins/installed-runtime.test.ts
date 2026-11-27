import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installFixture, writeFiles } from '../../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { PluginConfig } from '../../config/schema.js'
import { recordLayerPath, setEnabledPlugin } from './enabled-records.js'
import { pluginDataDir } from './hook-entries.js'
import { installedPluginsPath } from './records.js'
import { type CliPluginRuntime, createCliPluginRuntime } from './runtime.js'

let root: string
let home: string
let cwd: string
const runtimes: CliPluginRuntime[] = []

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-installed-'))
	home = join(root, 'home')
	cwd = join(root, 'app')
	mkdirSync(home, { recursive: true })
	mkdirSync(cwd, { recursive: true })
	vi.stubEnv('NAMZU_HOME', home)
})

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

const on = (layer: 'user' | 'project' | 'local', id: string, value = true) =>
	setEnabledPlugin(recordLayerPath(layer, { home, cwd }), home, id, value)

async function start(
	config: PluginConfig = { enabled: true },
	host: { projectTrusted?: boolean } = { projectTrusted: true },
): Promise<CliPluginRuntime> {
	const runtime = await createCliPluginRuntime(config, cwd, undefined, undefined, host)
	if (!runtime) throw new Error('no runtime')
	runtimes.push(runtime)
	return runtime
}

const names = (runtime: CliPluginRuntime) => runtime.list().map((p) => p.name)

describe('installed plugins are the runtime’s third source', () => {
	it('loads a user install that the user turned on, with its skill, and keeps it off without a yes', async () => {
		installFixture(home, { id: 'ledger@m' })
		installFixture(home, { id: 'quiet@m' })
		on('user', 'ledger@m')
		const runtime = await start()
		const listed = Object.fromEntries(runtime.list().map((p) => [p.name, p]))
		expect(listed.ledger).toMatchObject({
			status: 'enabled',
			startupEnabled: true,
			installId: 'ledger@m',
			installScope: 'user',
			skills: ['ledger__ledger-skill'],
		})
		// An installed plugin with no recorded yes is present and off.
		expect(listed.quiet).toMatchObject({ status: 'disabled', startupEnabled: false })
	})

	it('does not let plugins.autoDiscovery hide an installed plugin', async () => {
		installFixture(home, { id: 'ledger@m' })
		on('user', 'ledger@m')
		const runtime = await start({ enabled: true, autoDiscovery: false })
		expect(names(runtime)).toEqual(['ledger'])
	})

	it('loads nothing from the records when plugins.enabled is off', async () => {
		installFixture(home, { id: 'ledger@m' })
		on('user', 'ledger@m')
		const runtime = await createCliPluginRuntime({ enabled: false, launchDirs: [] }, cwd, {
			session_start: [{ command: 'true' }],
		})
		runtimes.push(runtime as CliPluginRuntime)
		expect(runtime?.list()).toEqual([])
	})

	it('runs from the cache folder and keeps data under plugins/data/<id>', async () => {
		const fixture = installFixture(home, { id: 'ledger@m' })
		on('user', 'ledger@m')
		const runtime = await start()
		expect(runtime.list()[0]?.rootDir).toBe(
			// the canonical form of the cache folder
			realpathSync(fixture.installPath),
		)
		expect(
			pluginDataDir(home, {
				name: 'ledger',
				scope: 'user',
				rootDir: '/x',
				installedId: 'ledger@m',
			}),
		).toBe(join(home, 'plugins', 'data', 'ledger@m'))
		// A plugin with no record keeps the older place.
		expect(pluginDataDir(home, { name: 'ledger', scope: 'user', rootDir: '/x' })).toBe(
			join(home, 'plugin-data', 'user', 'ledger'),
		)
	})

	it('reads a plugin in the common layout through its record', async () => {
		installFixture(home, { id: 'common@m', layout: 'common' })
		on('user', 'common@m')
		const runtime = await start()
		expect(runtime.list()[0]).toMatchObject({
			name: 'common',
			status: 'enabled',
			skills: ['common__common-skill'],
		})
	})

	it('skips the plugin folders that hold Namzu’s own state when it scans the hand-placed ones', async () => {
		writeFiles(join(home, 'plugins', 'cache'), {
			'plugin.json': { name: 'sneaky', version: '1.0.0', description: 'x', skills: [] },
		})
		writeFiles(join(home, 'plugins', 'data'), {
			'plugin.json': { name: 'sneaky-data', version: '1.0.0', description: 'x', skills: [] },
		})
		writeFiles(join(home, 'plugins', 'real'), {
			'plugin.json': { name: 'real', version: '1.0.0', description: 'x', skills: [] },
		})
		const runtime = await start()
		expect(names(runtime)).toEqual(['real'])
	})
})

describe('a record is only read where it may be', () => {
	it('reads no project record, and no project settings file, in a folder that is not trusted', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		on('project', 'proj@m')
		const untrusted = await start({ enabled: true }, { projectTrusted: false })
		expect(names(untrusted)).toEqual([])
		await untrusted.close()
		runtimes.pop()
		const trusted = await start({ enabled: true }, { projectTrusted: true })
		expect(trusted.list()[0]).toMatchObject({
			name: 'proj',
			status: 'enabled',
			installScope: 'project',
		})
	})

	it('asks the trust list when the host does not say, and the list holds nothing here', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		on('project', 'proj@m')
		const runtime = await createCliPluginRuntime({ enabled: true }, cwd)
		runtimes.push(runtime as CliPluginRuntime)
		expect(runtime?.list()).toEqual([])
	})

	it('never enables a plugin because a project file names it: no record, nothing loads', async () => {
		on('project', 'ghost@m')
		const runtime = await start()
		expect(names(runtime)).toEqual([])
	})

	it('ignores a project record made for another folder', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: join(root, 'other') })
		on('project', 'proj@m')
		const runtime = await start()
		expect(names(runtime)).toEqual([])
	})

	it('respects plugins.allowedScopes', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		installFixture(home, { id: 'user@m' })
		on('project', 'proj@m')
		on('user', 'user@m')
		const runtime = await start({ enabled: true, allowedScopes: ['user'] })
		expect(names(runtime)).toEqual(['user'])
	})
})

describe('who says on, across the three layers', () => {
	it('lets local beat project beat user', async () => {
		installFixture(home, { id: 'a@m' })
		installFixture(home, { id: 'b@m' })
		installFixture(home, { id: 'c@m' })
		on('user', 'a@m')
		on('project', 'a@m', false) // a project no turns a user plugin off here
		on('user', 'b@m')
		on('project', 'b@m', false)
		on('local', 'b@m', true) // and this computer's file turns it back on
		on('user', 'c@m', false)
		on('project', 'c@m', true) // a project yes counts here: the user has it installed
		const runtime = await start()
		const state = Object.fromEntries(runtime.list().map((p) => [p.name, p.status]))
		expect(state).toEqual({ a: 'disabled', b: 'enabled', c: 'enabled' })
	})

	it('also writes this computer’s file when it would undo a user-scope toggle', async () => {
		installFixture(home, { id: 'u@m' })
		on('user', 'u@m')
		on('local', 'u@m') // this computer's file says yes and outranks the user file
		const runtime = await start()
		await runtime.setEnabled('u', false)
		await runtime.rememberState('u')
		const local = JSON.parse(readFileSync(recordLayerPath('local', { home, cwd }), 'utf8'))
		expect(local.enabledPlugins['u@m']).toBe(false)
		const again = await start()
		expect(again.list().find((p) => p.name === 'u')?.status).toBe('disabled')
	})

	it('says so when a hand-placed plugin folder has a reserved name', async () => {
		writeFiles(join(home, 'plugins', 'data'), {
			'plugin.json': { name: 'odd', version: '1.0.0', description: 'Odd.' },
		})
		const runtime = await start()
		expect(names(runtime)).not.toContain('odd')
		expect(runtime.takePluginHookWarnings().join('\n')).toContain('named for Namzu')
	})

	it('remembers a toggle in the user file for a user install and in the local file for a folder install', async () => {
		installFixture(home, { id: 'u@m' })
		installFixture(home, { id: 'p@m', scope: 'project', projectPath: cwd })
		on('user', 'u@m')
		on('project', 'p@m')
		const runtime = await start()
		await runtime.setEnabled('u', false)
		await runtime.rememberState('u')
		await runtime.setEnabled('p', false)
		await runtime.rememberState('p')
		expect(
			JSON.parse(readFileSync(recordLayerPath('user', { home, cwd }), 'utf8')).enabledPlugins[
				'u@m'
			],
		).toBe(false)
		expect(
			JSON.parse(readFileSync(recordLayerPath('local', { home, cwd }), 'utf8')).enabledPlugins[
				'p@m'
			],
		).toBe(false)
		// The shared file was not edited.
		expect(
			JSON.parse(readFileSync(recordLayerPath('project', { home, cwd }), 'utf8')).enabledPlugins[
				'p@m'
			],
		).toBe(true)
		const again = await start()
		expect(Object.fromEntries(again.list().map((p) => [p.name, p.status]))).toEqual({
			u: 'disabled',
			p: 'disabled',
		})
	})
})

describe('a plugin that cannot load never stops the others', () => {
	it('stops only the plugin whose executable file changed, and says so', async () => {
		const bad = installFixture(home, { id: 'bad@m' })
		installFixture(home, { id: 'good@m' })
		on('user', 'bad@m')
		on('user', 'good@m')
		writeFileSync(join(bad.installPath, 'scripts', 'run.sh'), '#!/bin/sh\necho changed\n')
		const runtime = await start()
		expect(names(runtime)).toEqual(['good'])
		expect(runtime.installedProblems()).toEqual([
			expect.objectContaining({
				id: 'bad@m',
				message: expect.stringContaining(
					'bad changed on disk after you accepted it, so it did not load. Reinstall it to review it again.',
				),
			}),
		])
		expect(runtime.takePluginHookWarnings().join('\n')).toContain('bad changed on disk')
	})

	it('skips a plugin with no install manifest, and one whose manifest is refused', async () => {
		installFixture(home, { id: 'bare@m', skipManifest: true })
		installFixture(home, {
			id: 'broken@m',
			files: {
				'plugin.json': { name: 'broken', version: 'x', description: 1 },
				'scripts/run.sh': '#!/bin/sh\n',
			},
		})
		installFixture(home, { id: 'good@m' })
		for (const id of ['bare@m', 'broken@m', 'good@m']) on('user', id)
		const runtime = await start()
		expect(names(runtime)).toEqual(['good'])
		expect(
			runtime
				.installedProblems()
				.map((p) => p.id)
				.sort(),
		).toEqual(['bare@m', 'broken@m'])
	})

	it('lets a hand-placed plugin win a name over an installed one, and the first installed win between two', async () => {
		writeFiles(join(home, 'plugins', 'ledger'), {
			'plugin.json': { name: 'ledger', version: '9.9.9', description: 'hand placed', skills: [] },
		})
		installFixture(home, { id: 'ledger@m' })
		installFixture(home, { id: 'twin@one', installedAt: '2026-11-01T00:00:00.000Z' })
		installFixture(home, { id: 'twin@two', installedAt: '2026-11-02T00:00:00.000Z' })
		for (const id of ['ledger@m', 'twin@one', 'twin@two']) on('user', id)
		const runtime = await start()
		const loaded = Object.fromEntries(runtime.list().map((p) => [p.name, p.version]))
		expect(loaded.ledger).toBe('9.9.9')
		expect(runtime.list().find((p) => p.name === 'twin')?.installId).toBe('twin@one')
		expect(
			runtime
				.installedProblems()
				.map((p) => p.id)
				.sort(),
		).toEqual(['ledger@m', 'twin@two'])
		expect(runtime.installedProblems()[0]?.message).toContain('already used')
	})
})

describe('a damaged record blocks instead of being deleted', () => {
	it('loads no installed plugin, keeps the file as it is, and still loads the hand-placed ones', async () => {
		installFixture(home, { id: 'ledger@m' })
		on('user', 'ledger@m')
		writeFiles(join(home, 'plugins', 'plain'), {
			'plugin.json': { name: 'plain', version: '1.0.0', description: 'x', skills: [] },
		})
		writeFileSync(installedPluginsPath(home), '{ damaged')
		const runtime = await start()
		expect(names(runtime)).toEqual(['plain'])
		expect(readFileSync(installedPluginsPath(home), 'utf8')).toBe('{ damaged')
		expect(runtime.installedProblems()[0]?.message).toContain(
			'The install record could not be read',
		)
	})

	it('treats a settings file that does not read as saying nothing', async () => {
		installFixture(home, { id: 'ledger@m' })
		on('user', 'ledger@m')
		writeFileSync(recordLayerPath('user', { home, cwd }), '{ damaged')
		const runtime = await start()
		expect(runtime.list()[0]?.status).toBe('disabled')
		expect(runtime.installedProblems()[0]?.message).toContain('could not be read')
	})
})
