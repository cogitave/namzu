/**
 * Hook entries a plugin ships: how they are read from the folder and the
 * manifest, what is said when they cannot be loaded, and that the runtime
 * attaches them while the plugin is on, with the plugin's folders, under the
 * switches.
 */

import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { resetHookConfigProblems } from '../../config/load.js'
import {
	CONVENTIONAL_HOOKS_FILE,
	dataDirOverlapsPlugin,
	pluginDataDir,
	readPluginHookEntriesOf,
} from './hook-entries.js'
import { type CliPluginRuntime, createCliPluginRuntime } from './runtime.js'

const roots: string[] = []
const runtimes: CliPluginRuntime[] = []
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.unstubAllEnvs()
	resetHookConfigProblems()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-plugin-entries-'))
	roots.push(dir)
	return dir
}

async function pluginFolder(
	base: string,
	manifest: Record<string, unknown> = {},
	files: Record<string, string> = {},
): Promise<string> {
	const dir = join(base, 'demo-plugin')
	await mkdir(dir, { recursive: true })
	await writeFile(
		join(dir, 'plugin.json'),
		JSON.stringify({ name: 'demo-plugin', version: '1.0.0', description: 'demo', ...manifest }),
	)
	for (const [rel, text] of Object.entries(files)) {
		await mkdir(join(dir, rel, '..'), { recursive: true })
		await writeFile(join(dir, rel), text)
	}
	return dir
}

function readOf(dir: string, manifest: Record<string, unknown> = {}) {
	return readPluginHookEntriesOf({
		rootDir: dir,
		manifest: { name: 'demo-plugin', version: '1.0.0', description: 'demo', ...manifest } as never,
	})
}

describe('reading the entries a plugin ships', () => {
	it('reads the conventional file in the common shape, with its `hooks` wrapper', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{},
			{
				[CONVENTIONAL_HOOKS_FILE]: JSON.stringify({
					description: 'guards',
					hooks: {
						PreToolUse: [
							{
								matcher: 'Bash',
								hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/guard.sh', timeout: 5 }],
							},
						],
					},
				}),
			},
		)
		const read = readOf(dir)
		expect(read.problems).toEqual([])
		expect(read.count).toBe(1)
		expect(read.hooks.pre_tool_use).toEqual([
			{
				command: '${CLAUDE_PLUGIN_ROOT}/guard.sh',
				matcher: 'Bash',
				timeoutMs: 5000,
				toolNames: 'written',
				source: 'plugin demo-plugin',
			},
		])
	})

	it('reads the events object itself, in our shape, with a note for a key beside `hooks`', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{},
			{
				'hooks/hooks.json': JSON.stringify({ turn_end: [{ command: './done.sh' }] }),
			},
		)
		const read = readOf(dir)
		expect(read.hooks.turn_end).toEqual([{ command: './done.sh', source: 'plugin demo-plugin' }])
		const wrapped = await pluginFolder(
			await scratch(),
			{},
			{
				'hooks/hooks.json': JSON.stringify({ hooks: { turn_end: [{ command: 'a' }] }, version: 2 }),
			},
		)
		const second = readOf(wrapped)
		expect(second.count).toBe(1)
		expect(second.problems).toEqual([
			expect.objectContaining({ severity: 'note', message: expect.stringContaining('"version"') }),
		])
	})

	it('reads a `.json` path of `hooks` and inline `hookEntries`, and leaves a module path alone', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{
				hooks: ['extra/more.json', 'mod.mjs'],
				hookEntries: { Stop: [{ hooks: [{ type: 'command', command: 'inline.sh' }] }] },
			},
			{ 'extra/more.json': JSON.stringify({ session_start: [{ command: 'start.sh' }] }) },
		)
		const read = readOf(dir, {
			hooks: ['extra/more.json', 'mod.mjs'],
			hookEntries: { Stop: [{ hooks: [{ type: 'command', command: 'inline.sh' }] }] },
		})
		expect(read.problems).toEqual([])
		expect(read.files).toEqual(['extra/more.json', 'plugin.json hookEntries'])
		expect(Object.keys(read.hooks).sort()).toEqual(['session_start', 'turn_end'])
	})

	it('reads an http entry and a prompt entry too', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{},
			{
				'hooks/hooks.json': JSON.stringify({
					hooks: {
						UserPromptSubmit: [
							{
								hooks: [
									{ type: 'http', url: 'http://127.0.0.1:9/hook' },
									{ type: 'prompt', prompt: 'Is this fine? $ARGUMENTS' },
								],
							},
						],
					},
				}),
			},
		)
		const read = readOf(dir)
		expect(read.hooks.user_prompt_submit?.map((entry) => entry.type)).toEqual(['http', 'prompt'])
	})

	it('runs an entry listed twice once, and the same text from two sources as two', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{ hookEntries: { turn_end: [{ command: 'same.sh' }] } },
			{ 'hooks/hooks.json': JSON.stringify({ turn_end: [{ command: 'same.sh' }] }) },
		)
		expect(readOf(dir, { hookEntries: { turn_end: [{ command: 'same.sh' }] } }).count).toBe(1)
	})

	it('refuses a path that leaves the plugin folder and says so', async () => {
		const base = await scratch()
		await writeFile(join(base, 'outside.json'), JSON.stringify({ turn_end: [{ command: 'x' }] }))
		const dir = await pluginFolder(base, {})
		const read = readOf(dir, { hooks: ['../outside.json', '/etc/hooks.json'] })
		expect(read.count).toBe(0)
		expect(read.problems.map((problem) => problem.code)).toEqual([
			'hook-entries-outside',
			'hook-entries-outside',
		])
		expect(read.problems[0]?.message).toContain('leaves the plugin folder')
		expect(read.problems[1]?.message).toContain('absolute path')
	})

	it('does not follow a link out of the plugin folder', async () => {
		const base = await scratch()
		await writeFile(join(base, 'real.json'), JSON.stringify({ turn_end: [{ command: 'x' }] }))
		const dir = await pluginFolder(base, {})
		await mkdir(join(dir, 'hooks'))
		await symlink(join(base, 'real.json'), join(dir, 'hooks', 'hooks.json'))
		const read = readOf(dir)
		expect(read.count).toBe(0)
		expect(read.problems[0]?.message).toContain('through a link')
		expect(read.problems[0]?.severity).toBe('problem')
	})

	it('says a listed file is missing, and that a file that is not JSON is not loaded', async () => {
		const base = await scratch()
		const dir = await pluginFolder(base, {}, { 'hooks/hooks.json': '{ not json' })
		const read = readOf(dir, { hooks: ['gone.json'] })
		expect(read.problems.map((problem) => problem.code).sort()).toEqual([
			'hook-entries-json',
			'hook-entries-missing',
		])
		expect(read.problems.every((problem) => problem.severity === 'problem')).toBe(true)
	})

	it('says a file that is not an object of events, and one event that cannot be loaded without losing the others', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{},
			{
				'hooks/hooks.json': JSON.stringify({
					pre_tool_use: [{ command: 'good.sh' }],
					on_save: [{ command: 'bad.sh' }],
					turn_end: [{ command: 'also-good.sh' }],
				}),
			},
		)
		const read = readOf(dir)
		expect(Object.keys(read.hooks).sort()).toEqual(['pre_tool_use', 'turn_end'])
		expect(read.problems).toHaveLength(1)
		expect(read.problems[0]?.severity).toBe('problem')
		expect(read.problems[0]?.message).toContain('on_save')
		const list = await pluginFolder(await scratch(), {}, { 'hooks/hooks.json': '[1]' })
		expect(readOf(list).problems[0]?.code).toBe('hook-entries-shape')
	})

	it('says an entry it cannot read on a guarding event, in the words a config file uses', async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{},
			{
				'hooks/hooks.json': JSON.stringify({
					PreToolUse: [
						{
							hooks: [
								{ type: 'agent', prompt: 'x' },
								{ type: 'command', command: 'ok.sh' },
							],
						},
					],
					UnknownEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
				}),
			},
		)
		const read = readOf(dir)
		expect(read.count).toBe(1)
		const messages = read.problems.map((problem) => `${problem.severity}: ${problem.message}`)
		expect(
			messages.some(
				(m) => m.includes('problem') && m.includes('what it was meant to guard is not checked'),
			),
		).toBe(true)
		expect(messages.some((m) => m.includes('UnknownEvent'))).toBe(true)
	})

	it("reads a plugin variable in the plugin's own entry without a problem", async () => {
		const base = await scratch()
		const dir = await pluginFolder(
			base,
			{},
			{
				'hooks/hooks.json': JSON.stringify({
					turn_end: [{ command: '${NAMZU_PLUGIN_ROOT}/a.sh', args: ['${NAMZU_PLUGIN_DATA}'] }],
				}),
			},
		)
		expect(readOf(dir).problems).toEqual([])
	})
})

describe('the data folder', () => {
	it('is under the home, never inside the plugin, and a project plugin gets its own', () => {
		const user = pluginDataDir('/home/.namzu', {
			name: 'a',
			scope: 'user',
			rootDir: '/home/.namzu/plugins/a',
		})
		const one = pluginDataDir('/home/.namzu', {
			name: 'a',
			scope: 'project',
			rootDir: '/r1/.namzu/plugins/a',
		})
		const two = pluginDataDir('/home/.namzu', {
			name: 'a',
			scope: 'project',
			rootDir: '/r2/.namzu/plugins/a',
		})
		expect(user).toBe('/home/.namzu/plugin-data/user/a')
		expect(one).not.toBe(two)
		expect(one).not.toBe(user)
		expect(dataDirOverlapsPlugin(user, '/home/.namzu/plugins/a')).toBe(false)
		expect(dataDirOverlapsPlugin('/p/a/data', '/p/a')).toBe(true)
		expect(dataDirOverlapsPlugin('/p', '/p/a')).toBe(true)
	})
})

describe('the plugin runtime', () => {
	async function project(
		manifest: Record<string, unknown>,
		files: Record<string, string>,
		scripts: Record<string, string> = {},
	): Promise<{ home: string; cwd: string }> {
		const home = await scratch()
		vi.stubEnv('NAMZU_HOME', home)
		const cwd = join(home, 'project')
		const dir = join(cwd, '.namzu/plugins/demo-plugin')
		await mkdir(dir, { recursive: true })
		await writeFile(
			join(dir, 'plugin.json'),
			JSON.stringify({ name: 'demo-plugin', version: '1.0.0', description: 'demo', ...manifest }),
		)
		for (const [rel, text] of Object.entries(files)) {
			await mkdir(join(dir, rel, '..'), { recursive: true })
			await writeFile(join(dir, rel), text)
		}
		for (const [rel, text] of Object.entries(scripts)) {
			await mkdir(join(dir, rel, '..'), { recursive: true })
			await writeFile(join(dir, rel), text)
			await chmod(join(dir, rel), 0o755)
		}
		return { home, cwd }
	}

	const guard = {
		'scripts/guard.sh':
			'#!/bin/sh\necho "blocked by the plugin" >&2\ntouch "$NAMZU_PLUGIN_DATA/seen"\nexit 2\n',
	}
	const hooksFile = {
		'hooks/hooks.json': JSON.stringify({
			hooks: {
				PreToolUse: [
					{
						matcher: 'Bash',
						hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' }],
					},
				],
			},
		}),
	}
	const call = {
		sessionId: SESSION,
		turnId: 'turn-1',
		toolName: 'bash',
		toolInput: { command: 'ls' },
	} as never

	async function start(
		cwd: string,
		hooksSwitch?: 'disabled' | 'managed-only',
	): Promise<CliPluginRuntime> {
		const runtime = (await createCliPluginRuntime(
			{ enabled: true, allowedScopes: ['project'] },
			cwd,
			undefined,
			undefined,
			hooksSwitch ? { hooksSwitch } : undefined,
		))!
		runtimes.push(runtime)
		return runtime
	}

	it('blocks the call while the plugin is on, and lets it through once the plugin is off', async () => {
		const { home, cwd } = await project({}, hooksFile, guard)
		const runtime = await start(cwd)
		const on = await runtime.manager.executeHooks('pre_tool_use', call)
		expect(on).toEqual([expect.objectContaining({ action: 'skip' })])
		// The data folder was created under the home, outside the plugin.
		const seen = join(
			pluginDataDir(home, {
				name: 'demo-plugin',
				scope: 'project',
				rootDir: runtime.list()[0]!.rootDir,
			}),
			'seen',
		)
		expect(existsSync(seen)).toBe(true)
		await runtime.setEnabled('demo-plugin', false)
		expect(await runtime.manager.executeHooks('pre_tool_use', call)).toEqual([])
		expect(runtime.pluginHookEntries()).toEqual([])
		await runtime.setEnabled('demo-plugin', true)
		expect(await runtime.manager.executeHooks('pre_tool_use', call)).toHaveLength(1)
	})

	it("lists the entries apart from the plugin's JavaScript hooks, with the plugin's name", async () => {
		const { cwd } = await project(
			{ hooks: ['mod.mjs'] },
			{
				...hooksFile,
				'mod.mjs':
					"export const hooks = [{ event: 'turn_end', handler: async () => ({ action: 'continue' }) }]\n",
			},
			guard,
		)
		const runtime = await start(cwd)
		expect(runtime.pluginHooks()).toEqual([{ plugin: 'demo-plugin', event: 'turn_end' }])
		expect(runtime.pluginHookEntries()).toEqual([
			expect.objectContaining({
				plugin: 'demo-plugin',
				event: 'pre_tool_use',
				entry: expect.objectContaining({ matcher: 'Bash' }),
			}),
		])
		const info = runtime.list()[0]!
		expect(info.hookEntries).toBe(1)
		expect(info.hookModules).toEqual(['mod.mjs'])
	})

	it('attaches nothing at the next start when the saved state of the plugin is off', async () => {
		const { cwd } = await project({}, hooksFile, guard)
		const first = await start(cwd)
		await first.setEnabled('demo-plugin', false)
		await first.rememberState('demo-plugin')
		await first.close()
		runtimes.pop()
		const second = await start(cwd)
		expect(await second.manager.executeHooks('pre_tool_use', call)).toEqual([])
		expect(second.pluginHookEntries()).toEqual([])
		// The count a plugin shows in /plugins does not depend on it being on.
		expect(second.list()[0]?.hookEntries).toBe(1)
	})

	it.each(['disabled', 'managed-only'] as const)(
		'attaches none of them under the %s switch, and still lists them as off',
		async (state) => {
			const { cwd } = await project({}, hooksFile, guard)
			const runtime = await start(cwd, state)
			expect(await runtime.manager.executeHooks('pre_tool_use', call)).toEqual([])
			expect(runtime.pluginHookEntries()).toEqual([expect.objectContaining({ off: state })])
		},
	)

	it("keeps the plugin's JavaScript hooks running under a switch", async () => {
		const { cwd } = await project(
			{ hooks: ['mod.mjs'] },
			{
				...hooksFile,
				'mod.mjs':
					"export const hooks = [{ event: 'pre_tool_use', handler: async () => ({ action: 'skip', reason: 'js' }) }]\n",
			},
			guard,
		)
		const runtime = await start(cwd, 'disabled')
		expect(await runtime.manager.executeHooks('pre_tool_use', call)).toEqual([
			expect.objectContaining({ action: 'skip', reason: 'js' }),
		])
	})

	it('reports what could not be loaded, and still attaches the rest', async () => {
		const { cwd } = await project(
			{},
			{
				'hooks/hooks.json': JSON.stringify({
					pre_tool_use: [{ command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' }],
					on_save: [{ command: 'x' }],
				}),
			},
			guard,
		)
		const runtime = await start(cwd)
		expect(await runtime.manager.executeHooks('pre_tool_use', call)).toHaveLength(1)
		expect(runtime.pluginHookProblems()).toEqual([
			expect.objectContaining({ plugin: 'demo-plugin', severity: 'problem' }),
		])
		const warnings = runtime.takePluginHookWarnings()
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain('Hook problem in plugin demo-plugin, hooks/hooks.json')
		expect(runtime.takePluginHookWarnings()).toEqual([])
	})

	it('runs an entry of the same text from a config file as a separate source', async () => {
		const { cwd } = await project({}, hooksFile, guard)
		const runtime = (await createCliPluginRuntime(
			{ enabled: true, allowedScopes: ['project'] },
			cwd,
			{ pre_tool_use: [{ command: 'true', matcher: 'Bash' }] },
		))!
		runtimes.push(runtime)
		expect(await runtime.manager.executeHooks('pre_tool_use', call)).toHaveLength(2)
	})
})
