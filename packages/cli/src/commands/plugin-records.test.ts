import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { addMarketplace, installFixture } from '../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { recordLayerPath, setEnabledPlugin } from '../integrations/plugins/enabled-records.js'
import { installedPluginsPath } from '../integrations/plugins/records.js'
import {
	type PluginRecordVerb,
	type PluginRecordsDeps,
	runPluginRecords,
} from './plugin-records.js'

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-plugin-cmd-'))
	home = join(root, 'home')
	cwd = realpathSync(mkdirSync(join(root, 'app'), { recursive: true }) ?? join(root, 'app'))
	mkdirSync(home, { recursive: true })
})
afterEach(() => removeTempDir(root))

async function run(
	verb: PluginRecordVerb,
	args: string[],
	options: { trusted?: boolean; loadingOn?: boolean } = {},
): Promise<{ code: number; out: string; err: string; json: () => Record<string, any> }> {
	let out = ''
	let err = ''
	const deps: PluginRecordsDeps = {
		out: (text) => {
			out += text
		},
		err: (text) => {
			err += text
		},
		cwd: () => cwd,
		namzuHome: home,
		isTrusted: () => options.trusted ?? true,
		loadingOn: options.loadingOn ?? true,
	}
	const code = await runPluginRecords(verb, args, deps)
	return { code, out, err, json: () => JSON.parse(out) }
}

const set = (layer: 'user' | 'project' | 'local', id: string, value = true) =>
	setEnabledPlugin(recordLayerPath(layer, { home, cwd }), home, id, value)
const fileOf = (layer: 'user' | 'project' | 'local') =>
	JSON.parse(readFileSync(recordLayerPath(layer, { home, cwd }), 'utf8'))

describe('namzu plugin list', () => {
	it('says so when nothing is installed', async () => {
		const result = await run('list', [])
		expect(result.code).toBe(0)
		expect(result.out).toBe('No plugins are installed here.\n')
		expect((await run('list', ['--json'])).json()).toMatchObject({
			command: 'plugin list',
			plugins: [],
			trusted: true,
		})
	})

	it('lists what applies here as JSON: id, version, scope, state, who said', async () => {
		installFixture(home, { id: 'ledger@m', version: '1.2.0' })
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		installFixture(home, { id: 'other@m', scope: 'project', projectPath: join(root, 'else') })
		set('user', 'ledger@m')
		set('project', 'proj@m', false)
		const json = (await run('list', ['--json'])).json()
		expect(json.plugins).toEqual([
			expect.objectContaining({
				id: 'ledger@m',
				name: 'ledger',
				marketplace: 'm',
				version: '1.2.0',
				scope: 'user',
				enabled: true,
				enabledBy: 'user',
				state: 'on',
				attention: 0,
			}),
			expect.objectContaining({
				id: 'proj@m',
				scope: 'project',
				projectPath: cwd,
				enabled: false,
				enabledBy: 'project',
				state: 'off',
			}),
		])
		expect(json.loading).toBe('on')
	})

	it('reads no folder record in a folder that is not trusted, and says how many it left out', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		installFixture(home, { id: 'ledger@m' })
		const json = (await run('list', ['--json'], { trusted: false })).json()
		expect(json.plugins.map((p: { id: string }) => p.id)).toEqual(['ledger@m'])
		expect(json.trusted).toBe(false)
		expect(json.notice).toContain('not trusted')
	})

	it('marks a plugin that changed on disk as blocked and counts it', async () => {
		const fixture = installFixture(home, { id: 'ledger@m' })
		set('user', 'ledger@m')
		writeFileSync(join(fixture.installPath, 'scripts', 'run.sh'), 'changed')
		const result = await run('list', [])
		expect(result.out).toContain('blocked')
		expect(result.out).toContain('changed on disk after you accepted it')
		const row = (await run('list', ['--json'])).json().plugins[0]
		expect(row).toMatchObject({ state: 'blocked', attention: 1 })
	})

	it('names what this folder asks for and does not have, and a marketplace it declares', async () => {
		set('project', 'ghost@m')
		const file = recordLayerPath('project', { home, cwd })
		const raw = JSON.parse(readFileSync(file, 'utf8'))
		raw.extraKnownMarketplaces = { team: { source: { source: 'github', repo: 'acme/team' } } }
		writeFileSync(file, JSON.stringify(raw))
		const json = (await run('list', ['--json'])).json()
		expect(json.asked).toEqual([{ id: 'ghost@m', layer: 'project', installed: false }])
		expect(json.declaredMarketplaces).toEqual([
			expect.objectContaining({ name: 'team', layer: 'project', added: false }),
		])
		const text = (await run('list', [])).out
		expect(text).toContain('ghost@m is asked for here and is not installed on this computer.')
		expect(text).toContain('team is declared by this project, not added.')
	})

	it('exits 66 and changes nothing when the install record cannot be read', async () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(installedPluginsPath(home), '{ no')
		const result = await run('list', ['--json'])
		expect(result.code).toBe(66)
		expect(result.json()).toMatchObject({ outcome: 'failed' })
		expect(readFileSync(installedPluginsPath(home), 'utf8')).toBe('{ no')
	})

	it('exits 64 for an option it does not have, such as --available', async () => {
		const result = await run('list', ['--available'])
		expect(result.code).toBe(64)
		expect(result.err).toContain('unknown option: --available')
	})

	it('adds a line when plugin loading is off', async () => {
		installFixture(home, { id: 'ledger@m' })
		expect((await run('list', [], { loadingOn: false })).out).toContain(
			'namzu config set plugins.enabled true',
		)
	})
})

describe('namzu plugin details', () => {
	it('shows the exact runtime names, the record, who turned it on and where its data is', async () => {
		installFixture(home, {
			id: 'ledger@m',
			version: '1.2.0',
			files: {
				'plugin.json': {
					name: 'ledger',
					version: '1.2.0',
					description: 'Books.',
					skills: ['skills/reconcile'],
					commands: ['commands'],
				},
				'skills/reconcile/SKILL.md': '---\nname: reconcile\ndescription: Reconciles.\n---\nBody\n',
				'commands/close.md': 'Close the month.',
				'scripts/run.sh': '#!/bin/sh\ntrue\n',
			},
		})
		addMarketplace(home, 'm')
		set('user', 'ledger@m')
		const json = (await run('details', ['ledger@m', '--json'])).json()
		expect(json).toMatchObject({
			command: 'plugin details',
			id: 'ledger@m',
			enabled: true,
			enabledBy: 'user',
			verification: { ok: true },
			origin: { source: 'directory' },
			data: { path: join(home, 'plugins', 'data', 'ledger@m'), bytes: null },
			inventory: {
				description: 'Books.',
				skills: ['ledger__reconcile'],
				commands: ['ledger__close'],
			},
			executableFiles: expect.arrayContaining(['scripts/run.sh', 'skills/reconcile/SKILL.md']),
		})
		expect(json.records[0]).toMatchObject({ scope: 'user', version: '1.2.0', layout: 'namzu' })
		const text = (await run('details', ['ledger'])).out
		expect(text).toContain('ledger@m 1.2.0')
		expect(text).toContain('ledger__reconcile')
	})

	it('answers a bare name when only one installed plugin has it, and exits 64 for several', async () => {
		installFixture(home, { id: 'ledger@one' })
		expect((await run('details', ['ledger', '--json'])).json().id).toBe('ledger@one')
		installFixture(home, { id: 'ledger@two' })
		const several = await run('details', ['ledger'])
		expect(several.code).toBe(64)
		expect(several.err).toContain('ledger@one, ledger@two')
	})

	it('exits 66 for a plugin that is not installed and 64 without an id', async () => {
		expect((await run('details', ['nope@m'])).code).toBe(66)
		expect((await run('details', [])).code).toBe(64)
		expect((await run('details', ['a@b@c'])).code).toBe(64)
	})

	it('exits 77 for a folder plugin in a folder that is not trusted', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		const result = await run('details', ['proj@m'], { trusted: false })
		expect(result.code).toBe(77)
		expect(result.err).toContain('not trusted')
	})
})

describe('a plugin that will not load', () => {
	it('shows a name used by a hand-placed plugin as blocked in list, details and enable', async () => {
		installFixture(home, { id: 'ledger@mkt' })
		set('user', 'ledger@mkt')
		mkdirSync(join(home, 'plugins', 'ledger'), { recursive: true })
		writeFileSync(
			join(home, 'plugins', 'ledger', 'plugin.json'),
			JSON.stringify({ name: 'ledger', version: '1.0.0', description: 'Mine.' }),
		)
		const list = (await run('list', ['--json'])).json()
		expect(list.plugins[0]).toMatchObject({ state: 'blocked', attention: 1 })
		expect(list.plugins[0].problem).toContain('already used by another plugin')
		const details = (await run('details', ['ledger@mkt', '--json'])).json()
		expect(details.verification).toMatchObject({ ok: false, code: 'name-clash' })
		const enable = await run('enable', ['ledger@mkt'])
		expect(enable.out).toContain('still blocked')
	})

	it('shows the second of two installed plugins with one name as blocked', async () => {
		installFixture(home, { id: 'ledger@one', installedAt: '2026-11-01T00:00:00.000Z' })
		installFixture(home, { id: 'ledger@two', installedAt: '2026-11-02T00:00:00.000Z' })
		const list = (await run('list', ['--json'])).json()
		expect(list.plugins.map((p: { id: string; state: string }) => [p.id, p.state])).toEqual([
			['ledger@one', 'off'],
			['ledger@two', 'blocked'],
		])
	})

	it('says on enable that a changed plugin is still blocked, and fills origin from the manifest', async () => {
		const fixture = installFixture(home, { id: 'ledger@mkt' })
		appendFileSync(join(fixture.installPath, 'scripts', 'run.sh'), 'echo hi\n')
		const enable = await run('enable', ['ledger@mkt'])
		expect(enable.code).toBe(0)
		expect(enable.out).toContain('still blocked and will not load')
		expect((await run('details', ['ledger@mkt', '--json'])).json().origin).toEqual({
			marketplace: 'mkt',
		})
	})
})

describe('namzu plugin enable and disable', () => {
	it('records a yes in the user file for a user install', async () => {
		installFixture(home, { id: 'ledger@m' })
		const result = await run('enable', ['ledger@m', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({
			command: 'plugin enable',
			outcome: 'enabled',
			id: 'ledger@m',
			scope: 'user',
			effective: { enabled: true, by: 'user' },
		})
		expect(fileOf('user').enabledPlugins).toEqual({ 'ledger@m': true })
		const off = await run('disable', ['ledger@m'])
		expect(off.out).toContain(
			'Turned off ledger@m (scope: user). It takes effect in new conversations.',
		)
		expect(fileOf('user').enabledPlugins).toEqual({ 'ledger@m': false })
	})

	it('says when it is already so and writes nothing', async () => {
		installFixture(home, { id: 'ledger@m' })
		set('user', 'ledger@m')
		const result = await run('enable', ['ledger@m', '--json'])
		expect(result.code).toBe(0)
		expect(result.json()).toMatchObject({ outcome: 'unchanged' })
	})

	it('writes the local file for a project plugin, and the shared file only with --scope project', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		set('project', 'proj@m')
		const off = await run('disable', ['proj@m', '--json'])
		expect(off.json()).toMatchObject({ outcome: 'disabled', scope: 'local' })
		expect(fileOf('local').enabledPlugins).toEqual({ 'proj@m': false })
		expect(fileOf('project').enabledPlugins).toEqual({ 'proj@m': true })
		const shared = await run('disable', ['proj@m', '--scope', 'project', '--json'])
		expect(shared.json()).toMatchObject({ outcome: 'disabled', scope: 'project' })
		expect(fileOf('project').enabledPlugins).toEqual({ 'proj@m': false })
	})

	it('says when another layer still decides', async () => {
		installFixture(home, { id: 'ledger@m' })
		set('local', 'ledger@m', false)
		const result = await run('enable', ['ledger@m', '--scope', 'user', '--json'])
		expect(result.json().notes[0]).toContain('still off here')
	})

	it('adds a note when plugin loading is off', async () => {
		installFixture(home, { id: 'ledger@m' })
		const result = await run('enable', ['ledger@m', '--json'], { loadingOn: false })
		expect(result.json().notes.join(' ')).toContain('namzu config set plugins.enabled true')
	})

	it('exits 77 for --scope project or local in a folder that is not trusted, and 64 for a scope that does not exist', async () => {
		installFixture(home, { id: 'proj@m', scope: 'project', projectPath: cwd })
		const untrusted = await run('enable', ['proj@m', '--scope', 'project'], { trusted: false })
		expect(untrusted.code).toBe(77)
		expect(untrusted.err).toContain(
			'This folder is not trusted yet. Open it with namzu once, or use --scope user.',
		)
		expect((await run('enable', ['proj@m', '--scope', 'galaxy'])).code).toBe(64)
		expect((await run('enable', ['proj@m', '--scope', 'user'])).code).toBe(66)
	})

	it('exits 66 for a plugin that is not installed, and prints JSON for the failure', async () => {
		const result = await run('enable', ['nope@m', '--json'])
		expect(result.code).toBe(66)
		expect(result.json()).toMatchObject({
			command: 'plugin enable',
			outcome: 'failed',
			id: 'nope@m',
		})
		expect((await run('enable', [])).code).toBe(64)
	})

	it('exits 66 and keeps the file when the settings file cannot be read', async () => {
		installFixture(home, { id: 'ledger@m' })
		const path = recordLayerPath('user', { home, cwd })
		writeFileSync(path, '{ no')
		const result = await run('enable', ['ledger@m'])
		expect(result.code).toBe(66)
		expect(readFileSync(path, 'utf8')).toBe('{ no')
	})

	it('exits 66 and keeps the install record when it cannot be read', async () => {
		mkdirSync(join(home, 'plugins'), { recursive: true })
		writeFileSync(installedPluginsPath(home), '[]')
		const result = await run('disable', ['ledger@m'])
		expect(result.code).toBe(66)
		expect(result.err).toContain('The install record could not be read, so nothing was changed')
		expect(readFileSync(installedPluginsPath(home), 'utf8')).toBe('[]')
	})
})
