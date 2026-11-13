/**
 * Where a person sees, checks and switches off the hook entries a plugin ships:
 * the config reader's problem for a plugin variable, `/hooks`, the doctor row,
 * the trust prompt's list, and `namzu plugin validate`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	hookConfigProblems,
	loadConfig,
	resetHookConfigProblems,
	takeConfigWarnings,
} from '../../config/load.js'
import { describeHooksStatus } from '../../doctor/checks/hooks.js'
import { pluginDetails, pluginSummary } from '../../tui/plugin-view.js'
import { renderHooks } from '../../tui/slashCommands.js'
import { readFolderGrants } from '../trust/folder-grants.js'
import { summarizePluginHooks } from './hook-entries.js'
import { validatePluginFolder } from './validate.js'

const dirs: string[] = []
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-plugin-views-'))
	dirs.push(dir)
	return dir
}
beforeEach(() => {
	resetHookConfigProblems()
	takeConfigWarnings()
})
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writePlugin(
	cwd: string,
	manifest: Record<string, unknown>,
	files: Record<string, string>,
): string {
	const dir = join(cwd, '.namzu/plugins/demo-plugin')
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'plugin.json'),
		JSON.stringify({ name: 'demo-plugin', version: '1.0.0', description: 'demo', ...manifest }),
	)
	for (const [rel, text] of Object.entries(files)) {
		mkdirSync(join(dir, rel, '..'), { recursive: true })
		writeFileSync(join(dir, rel), text)
	}
	return dir
}

const hooksFile = JSON.stringify({
	hooks: {
		PreToolUse: [
			{
				matcher: 'Bash',
				hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/guard.sh' }],
			},
		],
	},
})

describe('a plugin variable in a config file', () => {
	function load(hooks: unknown) {
		const home = scratch()
		mkdirSync(join(home, '.namzu'), { recursive: true })
		const cwd = scratch()
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify({ hooks }))
		return loadConfig({ home, cwd, env: {} })
	}

	it('is a note in our shape, in the common shape and by the shape of the name', () => {
		const hooks = load({
			pre_tool_use: [{ command: '${NAMZU_PLUGIN_ROOT}/guard.sh' }],
			PostToolUse: [
				{ hooks: [{ type: 'command', command: 'run', args: ['$OTHER_PLUGIN_DATA/x'] }] },
			],
		}).hooks
		// The entries are still read and still run, as they always did, and the person is told here.
		expect(hooks?.pre_tool_use).toHaveLength(1)
		const messages = hookConfigProblems().map(
			(problem) => `${problem.severity}: ${problem.message}`,
		)
		expect(messages).toHaveLength(2)
		expect(messages[0]).toContain('note')
		expect(messages[0]).toContain('$NAMZU_PLUGIN_ROOT')
		expect(messages[0]).toContain('only a hook entry a plugin ships is given')
		expect(messages[0]).toContain('the command still runs')
		expect(messages[1]).toContain('$OTHER_PLUGIN_DATA')
		expect(takeConfigWarnings().join('\n')).toContain('Hook note in')
	})

	it('is not a problem when the entry sets it itself', () => {
		load({
			pre_tool_use: [{ command: '${NAMZU_PLUGIN_ROOT}/a', env: { NAMZU_PLUGIN_ROOT: '/x' } }],
		})
		expect(hookConfigProblems()).toEqual([])
	})
})

describe('/hooks', () => {
	const entry = {
		command: '${NAMZU_PLUGIN_ROOT}/guard.sh',
		matcher: 'Bash',
		toolNames: 'written' as const,
		source: 'plugin demo-plugin',
	}

	it("lists the entries apart from the plugin's JavaScript hooks, with the plugin, event, command and matcher", () => {
		const text = renderHooks(undefined, {
			pluginHooks: [{ plugin: 'demo-plugin', event: 'turn_end' }],
			pluginEntries: [{ plugin: 'demo-plugin', event: 'pre_tool_use', entry }],
			problems: [],
		})
		expect(text).toContain('plugin hook entries (commands, addresses and prompts a plugin ships)')
		expect(text).toContain(
			'  pre_tool_use · plugin demo-plugin · ${NAMZU_PLUGIN_ROOT}/guard.sh · matches Bash',
		)
		expect(text).toContain('plugin hooks (JavaScript, set by the plugin)')
		expect(text.indexOf('plugin hook entries')).toBeLessThan(
			text.indexOf('plugin hooks (JavaScript'),
		)
	})

	it('shows entries even when nothing else is attached, and what could not be loaded', () => {
		const text = renderHooks(undefined, {
			pluginEntries: [{ plugin: 'demo-plugin', event: 'pre_tool_use', entry }],
			pluginProblems: [
				{
					plugin: 'demo-plugin',
					severity: 'problem',
					code: 'hook-entries-json',
					file: 'hooks/hooks.json',
					message: 'hooks/hooks.json is not valid JSON; its hooks are not loaded.',
				},
			],
			problems: [],
		})
		expect(text).not.toContain('No hooks.')
		expect(text).toContain(
			'Not loaded: plugin demo-plugin, hooks/hooks.json: hooks/hooks.json is not valid JSON',
		)
	})

	it('says an entry is off under a switch, and the switch line names them', () => {
		const text = renderHooks(undefined, {
			switch: 'disabled',
			pluginEntries: [{ plugin: 'demo-plugin', event: 'pre_tool_use', entry, off: 'disabled' }],
			problems: [],
		})
		expect(text).toContain('off (disableHooks)')
		expect(text).toContain('hook entries plugins ship')
		const managed = renderHooks(undefined, { switch: 'managed-only', problems: [] })
		expect(managed).toContain('no plugin comes from the managed file')
	})
})

describe('namzu doctor', () => {
	it('counts the entries per plugin, says what is not attached and why, and warns about a problem', () => {
		const summary = {
			unreadProjectPlugins: 0,
			plugins: [
				{ name: 'a', count: 2, enabled: true, problems: [] },
				{ name: 'b', count: 1, enabled: false, problems: [] },
				{
					name: 'c',
					count: 0,
					enabled: true,
					problems: [
						{
							severity: 'problem' as const,
							code: 'hook-entries-json' as const,
							file: 'hooks/hooks.json',
							message: 'not valid JSON; its hooks are not loaded.',
						},
					],
				},
			],
		}
		const result = describeHooksStatus({}, undefined, summary)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('2 plugin hook entries are attached: 2 from plugin a')
		expect(result.message).toContain('1 more is not attached (the plugin is off): b')
		expect(result.message).toContain('Not loaded: plugin c, hooks/hooks.json: not valid JSON')
	})

	it('says none are attached under a switch', () => {
		const summary = {
			plugins: [{ name: 'a', count: 2, enabled: true, problems: [] }],
			unreadProjectPlugins: 0,
		}
		const result = describeHooksStatus({ disableHooks: true }, undefined, summary)
		expect(result.message).toContain('0 plugin hook entries are attached.')
		expect(result.message).toContain('2 more are not attached (disableHooks is on): a')
		const managed = describeHooksStatus({ hooksManagedOnly: true }, undefined, summary)
		expect(managed.message).toContain('no plugin comes from the managed file')
	})

	it('says when no plugin ships any, and is a pass', () => {
		const result = describeHooksStatus({}, undefined, { plugins: [], unreadProjectPlugins: 0 })
		expect(result.status).toBe('pass')
		expect(result.message).toContain('No plugin ships hook entries.')
	})

	it('reads the plugins on disk, and a project plugin only when the folder is trusted', async () => {
		const home = scratch()
		const cwd = scratch()
		writePlugin(cwd, {}, { 'hooks/hooks.json': hooksFile })
		const options = {
			cwd,
			home,
			allowedScopes: ['project', 'user'] as const,
			autoDiscovery: true,
			enabled: () => true,
		}
		const trusted = await summarizePluginHooks({ ...options, trusted: true })
		expect(trusted.plugins).toEqual([expect.objectContaining({ name: 'demo-plugin', count: 1 })])
		const untrusted = await summarizePluginHooks({ ...options, trusted: false })
		expect(untrusted.plugins).toEqual([])
		expect(untrusted.unreadProjectPlugins).toBe(1)
		expect(trusted.unreadProjectPlugins).toBe(0)
		const row = describeHooksStatus({}, undefined, untrusted)
		expect(row.message).toContain(
			'1 plugin in this folder is not read, because the folder is not trusted',
		)
	})
})

describe('the folder trust prompt', () => {
	it('lists the entries a project plugin would run, with its name, before the answer', () => {
		const cwd = scratch()
		writePlugin(
			cwd,
			{ hookEntries: { turn_end: [{ command: 'inline.sh' }] } },
			{ 'hooks/hooks.json': hooksFile },
		)
		const grants = readFolderGrants(cwd)
		expect(grants.hooks).toEqual([
			{ event: 'PreToolUse', runs: '${NAMZU_PLUGIN_ROOT}/guard.sh (plugin demo-plugin)' },
			{ event: 'turn_end', runs: 'inline.sh (plugin demo-plugin)' },
		])
	})

	it('does not follow a manifest path out of the plugin folder', () => {
		const cwd = scratch()
		writeFileSync(join(cwd, 'outside.json'), JSON.stringify({ turn_end: [{ command: 'x' }] }))
		writePlugin(cwd, { hooks: ['../../../outside.json'] }, {})
		expect(readFolderGrants(cwd).hooks).toEqual([])
	})
})

describe('/plugins', () => {
	const info = {
		name: 'demo-plugin',
		version: '1.0.0',
		description: 'demo',
		scope: 'project' as const,
		rootDir: '/p',
		status: 'enabled',
		tools: [],
		skills: [],
		hookModules: [],
		mcpServers: [],
		commands: [],
		agents: [],
	}

	it('shows that the plugin ships hook entries, enabled or not', () => {
		expect(pluginSummary({ ...info, hookEntries: 2 })).toContain('2 hook entries')
		expect(pluginSummary({ ...info, hookEntries: 1, status: 'disabled' })).toContain('1 hook entry')
		expect(pluginSummary(info)).not.toContain('hook entr')
		expect(pluginDetails({ ...info, hookEntries: 2 })).toContain(
			'Hook entries (commands, addresses, prompts it ships): 2',
		)
		expect(pluginDetails(info)).toContain(
			'Hook entries (commands, addresses, prompts it ships): none',
		)
	})
})

describe('namzu plugin validate', () => {
	it('is clean for the conventional file, a `.json` path and inline entries', async () => {
		const cwd = scratch()
		const dir = writePlugin(
			cwd,
			{
				hooks: ['extra/more.json'],
				hookEntries: { Stop: [{ hooks: [{ type: 'command', command: 'done.sh' }] }] },
			},
			{
				'hooks/hooks.json': hooksFile,
				'extra/more.json': JSON.stringify({ turn_end: [{ command: 'x.sh' }] }),
			},
		)
		const report = await validatePluginFolder(dir)
		expect(report.problems).toEqual([])
		expect(
			report.parts
				.filter((part) => part.kind === 'hook')
				.map((part) => part.name)
				.sort(),
		).toEqual(['extra/more.json', 'hookEntries', 'hooks/hooks.json'])
	})

	it('names each problem: a path out of the folder, a missing file, bad JSON, a bad event', async () => {
		const cwd = scratch()
		const dir = writePlugin(
			cwd,
			{ hooks: ['../outside.json', 'gone.json'] },
			{
				'hooks/hooks.json': JSON.stringify({
					pre_tool_use: [{ command: 'ok.sh' }],
					on_save: [{ command: 'x' }],
				}),
			},
		)
		const report = await validatePluginFolder(dir)
		const codes = report.problems.map((problem) => problem.code).sort()
		expect(codes).toContain('hook-entries-outside')
		expect(codes).toContain('hook-entries-missing')
		expect(codes).toContain('hook-entries-invalid')
		for (const problem of report.problems.filter((p) => p.code.startsWith('hook-entries'))) {
			expect(problem.level).toBe('error')
			expect(problem.consequence).toContain('not attached')
		}
		expect(report.status).toBe('errors')
	})

	it('does not call a plugin empty when its only contribution is the conventional hooks file', async () => {
		const cwd = scratch()
		const dir = writePlugin(cwd, {}, { 'hooks/hooks.json': hooksFile })
		const report = await validatePluginFolder(dir)
		expect(report.problems.map((problem) => problem.code)).not.toContain('manifest-empty')
		const bare = writePlugin(scratch(), {}, {})
		expect((await validatePluginFolder(bare)).problems.map((problem) => problem.code)).toContain(
			'manifest-empty',
		)
	})

	it('no longer warns that a `.json` hook path is not a module', async () => {
		const cwd = scratch()
		const dir = writePlugin(cwd, { hooks: ['hooks/hooks.json'] }, { 'hooks/hooks.json': hooksFile })
		const report = await validatePluginFolder(dir)
		expect(report.problems.map((problem) => problem.code)).not.toContain('module-extension')
		expect(report.problems.map((problem) => problem.code)).not.toContain('module-export')
	})
})
