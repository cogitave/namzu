import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { discoverUserCommands } from '../../user-commands/store.js'
import { discoverAgentDefinitions } from '../subagents/definitions.js'
import { readPluginFileSources, resolvePluginFileDirs } from './files.js'

let root: string
let cwd: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-plugin-files-'))
	cwd = join(root, 'project')
	home = join(root, 'home')
	mkdirSync(cwd, { recursive: true })
	mkdirSync(home, { recursive: true })
})

afterEach(() => removeTempDir(root))

function plugin(dir: string, name: string, extra: Record<string, unknown> = {}): string {
	mkdirSync(join(dir, 'commands'), { recursive: true })
	mkdirSync(join(dir, 'agents'), { recursive: true })
	writeFileSync(
		join(dir, 'plugin.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			description: 'Test plugin',
			commands: ['commands'],
			agents: ['agents'],
			...extra,
		}),
	)
	writeFileSync(
		join(dir, 'commands', 'audit.md'),
		'---\ndescription: Audit it\n---\nAudit $ARGUMENTS',
	)
	writeFileSync(
		join(dir, 'agents', 'checker.md'),
		'---\nname: checker\ndescription: Checks things.\n---\nCHECKER-PROMPT',
	)
	return dir
}

describe('what a plugin contributes as files', () => {
	it('contributes nothing while plugins are off', async () => {
		plugin(join(cwd, '.namzu', 'plugins', 'ledger'), 'ledger')
		const found = await readPluginFileSources({ cwd, userRoot: home, config: {} })
		expect(found.commands).toEqual([])
		expect(found.agents).toEqual([])
	})

	it('turns a plugin command file into /<plugin>__<file> and fills its arguments', async () => {
		plugin(join(cwd, '.namzu', 'plugins', 'ledger'), 'ledger')
		const found = await readPluginFileSources({ cwd, userRoot: home, config: { enabled: true } })
		const [command] = discoverUserCommands({
			home,
			cwd,
			pluginCommandDirs: found.commands,
		})
		expect(command).toMatchObject({
			name: 'ledger__audit',
			source: 'plugin',
			description: 'Audit it',
			template: 'Audit $ARGUMENTS',
		})
	})

	it('lets the project own a command of the same name over a plugin', async () => {
		plugin(join(cwd, '.namzu', 'plugins', 'ledger'), 'ledger')
		mkdirSync(join(cwd, '.namzu', 'commands'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'commands', 'ledger__audit.md'), 'project wins')
		const found = await readPluginFileSources({ cwd, userRoot: home, config: { enabled: true } })
		const commands = discoverUserCommands({ home, cwd, pluginCommandDirs: found.commands })
		expect(commands).toHaveLength(1)
		expect(commands[0]).toMatchObject({ source: 'project', template: 'project wins' })
	})

	it('names a plugin agent <plugin>__<name> and keeps the user own agents ahead of it', async () => {
		plugin(join(cwd, '.namzu', 'plugins', 'ledger'), 'ledger')
		const found = await readPluginFileSources({ cwd, userRoot: home, config: { enabled: true } })
		const discovered = await discoverAgentDefinitions({
			cwd,
			home,
			pluginAgentDirs: found.agents,
		})
		expect(discovered.definitions.map((d) => [d.name, d.source])).toEqual([
			['ledger__checker', 'plugin'],
		])
		expect(discovered.definitions[0]?.prompt).toContain('CHECKER-PROMPT')
	})

	it('skips a plugin that is saved as disabled', async () => {
		const dir = plugin(join(cwd, '.namzu', 'plugins', 'ledger'), 'ledger')
		const { PluginSettingsStore } = await import('./settings.js')
		const { realpathSync } = await import('node:fs')
		new PluginSettingsStore(home).write({ rootDir: realpathSync(dir), name: 'ledger' }, false)
		const found = await readPluginFileSources({ cwd, userRoot: home, config: { enabled: true } })
		expect(found.commands).toEqual([])
		expect(found.agents).toEqual([])
	})

	it('loads a folder named with --plugin-dir even though plugins are off, from outside the project', async () => {
		const outside = plugin(join(root, 'elsewhere', 'tryout'), 'tryout')
		const found = await readPluginFileSources({
			cwd,
			userRoot: home,
			config: { launchDirs: [outside] },
		})
		expect(found.commands.map((c) => c.plugin)).toEqual(['tryout'])
		expect(found.agents.map((c) => c.plugin)).toEqual(['tryout'])
	})

	it('refuses a declared folder that is a link out of the plugin', () => {
		const dir = plugin(join(root, 'p'), 'p')
		mkdirSync(join(root, 'secret'))
		symlinkSync(join(root, 'secret'), join(dir, 'linked'))
		const resolved = resolvePluginFileDirs('p', dir, ['linked', 'missing'])
		expect(resolved.dirs).toEqual([])
		expect(resolved.problems).toHaveLength(2)
		expect(resolved.problems[0]).toMatch(/outside the plugin folder/)
		expect(resolved.problems[1]).toMatch(/not found/)
	})
})
