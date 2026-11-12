import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { hookSwitch, hooksBySource } from './hook-layers.js'
import { loadBootstrapConfigWithProvenance, loadConfig, takeConfigWarnings } from './load.js'

interface Files {
	readonly user?: string
	readonly project?: object
	readonly local?: object
	readonly managed?: object
}

function folder(files: Files, env: NodeJS.ProcessEnv = {}) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-hook-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (files.user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), files.user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-hook-cwd-'))
	if (files.project) writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project))
	if (files.local) writeFileSync(join(cwd, 'namzu.config.local.json'), JSON.stringify(files.local))
	const managedPath = join(cwd, 'managed.json')
	if (files.managed) writeFileSync(managedPath, JSON.stringify(files.managed))
	return { home, cwd, env, managedPath }
}

const userYaml = (command: string, event = 'pre_tool_use') =>
	`hooks:\n  ${event}:\n    - command: ${command}\n`
const json = (command: string, event = 'pre_tool_use', extra: object = {}) => ({
	hooks: { [event]: [{ command, ...extra }] },
})
const commandsAt = (config: ReturnType<typeof loadConfig>, event: 'pre_tool_use' | 'turn_end') =>
	(config.hooks?.[event] ?? []).map((entry) => ('command' in entry ? entry.command : '?'))

describe('hooks from several files combine', () => {
	it('attaches the entries of every layer in a fixed order, the managed file last', () => {
		const config = loadConfig(
			folder({
				user: userYaml('user-guard'),
				project: json('project-check'),
				local: json('local-note'),
				managed: json('managed-policy'),
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual([
			'user-guard',
			'project-check',
			'local-note',
			'managed-policy',
		])
	})

	it('keeps the user hooks when a project file has hooks for the same event', () => {
		const config = loadConfig(
			folder({ user: userYaml('user-guard', 'turn_end'), project: json('p', 'turn_end') }),
		)
		expect(commandsAt(config, 'turn_end')).toEqual(['user-guard', 'p'])
	})

	it('remembers the file each entry came from', () => {
		const files = folder({ user: userYaml('a'), project: json('b'), managed: json('c') })
		const entries = loadConfig(files).hooks?.pre_tool_use ?? []
		expect(entries.map((entry) => entry.source)).toEqual([
			expect.stringMatching(/\.namzu[\\/]config\.yaml$/),
			expect.stringMatching(/namzu\.config\.json$/),
			expect.stringMatching(/managed\.json$/),
		])
		expect([...hooksBySource(loadConfig(files).hooks).values()]).toEqual([1, 1, 1])
	})

	it('attaches an entry that reads the same in two layers once, at its first place', () => {
		const config = loadConfig(
			folder({
				user: userYaml('shared'),
				project: { hooks: { pre_tool_use: [{ command: 'shared' }, { command: 'only-project' }] } },
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual(['shared', 'only-project'])
		expect(config.hooks?.pre_tool_use?.[0]?.source).toMatch(/config\.yaml$/)
	})

	it('treats entries that differ in any option as different', () => {
		const config = loadConfig(
			folder({
				user: userYaml('shared'),
				project: json('shared', 'pre_tool_use', { matcher: 'bash' }),
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual(['shared', 'shared'])
	})

	it('does not read the project hooks before the folder is trusted', () => {
		const files = folder({ user: userYaml('user-guard'), project: json('project-check') })
		const bootstrap = loadBootstrapConfigWithProvenance(files).config
		expect(commandsAt(bootstrap, 'pre_tool_use')).toEqual(['user-guard'])
	})
})

describe('the two switches', () => {
	it('disableHooks in a file drops every hook that is not the managed file’s', () => {
		const config = loadConfig(
			folder({
				user: `disableHooks: true\n${userYaml('user-guard')}`,
				project: json('project-check'),
				managed: json('managed-policy'),
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual(['managed-policy'])
		expect(hookSwitch(config)).toBe('disabled')
	})

	it('NAMZU_DISABLE_HOOKS does the same for one run', () => {
		const files = folder(
			{ user: userYaml('user-guard'), managed: json('managed-policy') },
			{ NAMZU_DISABLE_HOOKS: '1' },
		)
		expect(commandsAt(loadConfig(files), 'pre_tool_use')).toEqual(['managed-policy'])
		expect(commandsAt(loadConfig({ ...files, env: {} }), 'pre_tool_use')).toEqual([
			'user-guard',
			'managed-policy',
		])
	})

	it('leaves no hooks key when nothing is left', () => {
		const config = loadConfig(folder({ user: `disableHooks: true\n${userYaml('user-guard')}` }))
		expect(config.hooks).toBeUndefined()
	})

	it('cannot be turned back off by a later layer', () => {
		const config = loadConfig(
			folder({
				user: `disableHooks: true\n${userYaml('user-guard')}`,
				project: { disableHooks: false, ...json('project-check') },
			}),
		)
		expect(config.hooks).toBeUndefined()
		expect(config.disableHooks).toBe(true)
	})

	it('is ignored in a project or local file, so a repository cannot switch off the person’s own hooks', () => {
		const config = loadConfig(
			folder({
				user: userYaml('user-guard'),
				project: { disableHooks: true, ...json('project-check') },
				local: { disableHooks: true },
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual(['user-guard', 'project-check'])
		expect(config.disableHooks).not.toBe(true)
		const warnings = takeConfigWarnings().join('\n')
		expect(warnings).toMatch(/disableHooks in .*namzu\.config\.json is ignored/)
		expect(warnings).toMatch(/disableHooks in .*namzu\.config\.local\.json is ignored/)
	})

	it('refuses a NAMZU_DISABLE_HOOKS value that is not true or false', () => {
		expect(() => loadConfig(folder({}, { NAMZU_DISABLE_HOOKS: 'maybe' }))).toThrow(/disableHooks/)
	})

	it('hooksManagedOnly in the managed file attaches only the managed hooks', () => {
		const config = loadConfig(
			folder({
				user: userYaml('user-guard'),
				project: json('project-check'),
				managed: { hooksManagedOnly: true, ...json('managed-policy') },
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual(['managed-policy'])
		expect(hookSwitch(config)).toBe('managed-only')
	})

	it('hooksManagedOnly in a user or project file is ignored, with a note', () => {
		takeConfigWarnings()
		const config = loadConfig(
			folder({
				user: `hooksManagedOnly: true\n${userYaml('user-guard')}`,
				project: { hooksManagedOnly: true, ...json('project-check') },
			}),
		)
		expect(commandsAt(config, 'pre_tool_use')).toEqual(['user-guard', 'project-check'])
		expect(hookSwitch(config)).toBeUndefined()
		const warnings = takeConfigWarnings()
		expect(warnings.filter((line) => line.includes('hooksManagedOnly'))).toHaveLength(2)
	})
})
