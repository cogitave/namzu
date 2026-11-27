/**
 * The hooks module of a plugin in the common layout, in the CLI: it runs when
 * the plugin is on and stops when it is off, the trust screen and the validate
 * report say what it does before it runs, and a refused module leaves the
 * plugin's other hooks alone.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionId } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { renderPluginReport } from '../../commands/plugin.js'
import { readFolderGrants } from '../trust/folder-grants.js'
import { createCliPluginRuntime } from './runtime.js'
import { validatePluginFolder } from './validate.js'

const MANIFEST = '.claude-plugin/plugin.json'
const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId

let root: string
let cwd: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-hmod-cli-'))
	cwd = join(root, 'project')
	mkdirSync(cwd, { recursive: true })
	mkdirSync(join(root, 'home'), { recursive: true })
	vi.stubEnv('NAMZU_HOME', join(root, 'home'))
	vi.stubEnv('NAMZU_NETWORK', 'off')
})

afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function make(name: string, files: Record<string, string | object>, base = join(root, 'plugins')) {
	const dir = join(base, name)
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
	}
	return dir
}

const MODULE = `
export function register(on) {
	on('classic.UserPromptSubmit', async ($, e) => {
		await $.process.run([process_name(), '-v'])
		return { additionalContext: ['module saw: ' + e.prompt] }
	})
	on('tool.call', ($, e, next) => next(e))
}
function process_name() { return 'git' }
`

const PLAIN = `
export function register(on) {
	on('classic.UserPromptSubmit', ($, e) => ({ additionalContext: ['module saw: ' + e.prompt] }))
}
`

describe('a hooks module through the plugin runtime', () => {
	it('runs while the plugin is on, in its own worker, and stops when it is turned off', async () => {
		const dir = make('modplug', {
			[MANIFEST]: { name: 'modplug', description: 'Has a module.' },
			'hooks/hooks.json': { modules: ['./mod.js'] },
			'hooks/mod.js': PLAIN,
		})
		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd)
		expect(runtime?.list()[0]).toMatchObject({ name: 'modplug', hookModules: ['hooks/mod.js'] })
		expect(runtime?.pluginHooks()).toEqual([{ plugin: 'modplug', event: 'user_prompt_submit' }])
		const answer = async () =>
			await runtime?.manager.executeHooks('user_prompt_submit', {
				sessionId: SESSION,
				prompt: 'hi',
			})
		expect(await answer()).toEqual([{ action: 'annotate', text: 'module saw: hi' }])
		await runtime?.setEnabled('modplug', false)
		expect(runtime?.pluginHooks()).toEqual([])
		expect(await answer()).toEqual([])
		await runtime?.setEnabled('modplug', true)
		expect(await answer()).toEqual([{ action: 'annotate', text: 'module saw: hi' }])
		await runtime?.close()
	})

	it('says once when a module is refused, and the plugin still loads', async () => {
		const dir = make('badplug', {
			[MANIFEST]: { name: 'badplug', description: 'Has a bad module.' },
			'hooks/hooks.json': { modules: ['./mod.js'] },
			'hooks/mod.js': `import fs from 'node:fs'\nexport function register(on) { on('classic.Stop', () => ({})) }`,
		})
		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd)
		expect(runtime?.list()[0]).toMatchObject({ name: 'badplug', status: 'enabled' })
		const lines = runtime?.takePluginHookWarnings() ?? []
		expect(lines.some((line) => line.includes('cannot import "node:fs"'))).toBe(true)
		expect(lines.some((line) => line.includes('not loaded'))).toBe(true)
		expect(runtime?.pluginHooks()).toEqual([])
		await runtime?.close()
	})

	it('does not start a module while hooks are switched off', async () => {
		const dir = make('quiet', {
			[MANIFEST]: { name: 'quiet' },
			'hooks/hooks.json': { modules: ['./mod.js'] },
			'hooks/mod.js': PLAIN,
		})
		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd, undefined, undefined, {
			hooksSwitch: 'off' as never,
		})
		expect(runtime?.pluginHooks()).toEqual([])
		await runtime?.close()
	})

	it('keeps a plugin that has plain hook entries and a module reading both', async () => {
		const dir = make('both', {
			[MANIFEST]: { name: 'both' },
			'hooks/hooks.json': {
				modules: ['./mod.js'],
				hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] },
			},
			'hooks/mod.js': PLAIN,
		})
		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd)
		expect(runtime?.pluginHookEntries().map((entry) => entry.event)).toEqual(['session_start'])
		expect(runtime?.pluginHookProblems()).toEqual([])
		expect(runtime?.pluginHooks()).toEqual([{ plugin: 'both', event: 'user_prompt_submit' }])
		await runtime?.close()
	})
})

describe('what the person is told before a module runs', () => {
	it('lists the module on the trust screen with its events and what it does', () => {
		make(
			'modplug',
			{
				[MANIFEST]: { name: 'modplug' },
				'hooks/hooks.json': { modules: ['./mod.js'] },
				'hooks/mod.js': MODULE,
			},
			join(cwd, '.namzu', 'plugins'),
		)
		const grants = readFolderGrants(cwd)
		expect(grants.hooks).toEqual([
			{
				event: 'hooks module (plugin modplug)',
				runs: 'hooks/mod.js runs in an isolated worker: hooks UserPromptSubmit; runs commands',
			},
		])
	})

	it('says a refused module does not run, and lists the plain entries beside it', () => {
		make(
			'refused',
			{
				[MANIFEST]: { name: 'refused' },
				'hooks/hooks.json': {
					modules: ['./mod.js'],
					hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
				},
				'hooks/mod.js': `import x from 'node:os'\nexport function register(on) {}`,
			},
			join(cwd, '.namzu', 'plugins'),
		)
		const grants = readFolderGrants(cwd)
		expect(grants.hooks.map((hook) => hook.event)).toEqual([
			'Stop',
			'hooks module (plugin refused)',
		])
		expect(grants.hooks[1]?.runs).toContain('is not run')
	})

	it('prints the scan in the validate report and as JSON', async () => {
		const dir = make('modplug', {
			[MANIFEST]: { name: 'modplug', description: 'Has a module.' },
			'hooks/hooks.json': { modules: ['./mod.js'] },
			'hooks/mod.js': MODULE,
		})
		const report = await validatePluginFolder(dir)
		expect(report.hooksModule).toMatchObject({
			entry: 'hooks/mod.js',
			lines: ['hooks UserPromptSubmit', 'runs commands'],
		})
		expect(report.hooksModule?.hooks.map((hook) => [hook.pattern, hook.runs])).toEqual([
			['classic.UserPromptSubmit', true],
			['tool.call', false],
		])
		const text = renderPluginReport(report)
		expect(text).toContain(
			'hooks module hooks/mod.js runs in an isolated worker when the plugin is on:',
		)
		expect(text).toContain('  runs commands')
		expect(text).toContain(
			'  not used  Namzu runs classic.* hooks from modules; tool.call is not available.',
		)
		expect(text).toContain('calls  $.process.run')
		expect(report.problems.some((problem) => problem.code === 'hooks-module-not-used')).toBe(true)
	})

	it('reports two modules as a refusal of the second, and a module with a bad import as an error line', async () => {
		const two = await validatePluginFolder(
			make('two', {
				[MANIFEST]: { name: 'two' },
				'hooks/hooks.json': { modules: ['./a.js', './b.js'] },
			}),
		)
		expect(two.problems.map((problem) => problem.message).join('\n')).toContain(
			'names one hooks module per plugin; a second entry is refused',
		)
		expect(two.hooksModule).toBeUndefined()
		const bad = await validatePluginFolder(
			make('bad', {
				[MANIFEST]: { name: 'bad' },
				'hooks/hooks.json': { modules: ['./mod.js'] },
				'hooks/mod.js': `import x from 'node:fs'\nexport function register(on) {}`,
			}),
		)
		expect(bad.problems.some((problem) => problem.code === 'hooks-module-scan-refused')).toBe(true)
	})
})
