import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolRegistry, createSkillTool } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type CliPluginRuntime, createCliPluginRuntime } from './runtime.js'
import { PluginSettingsStore } from './settings.js'

const roots: string[] = []
const runtimes: CliPluginRuntime[] = []
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('does not import disabled contributions on restart, but can explicitly re-enable them', async () => {
	const home = await mkdtemp(join(tmpdir(), 'namzu-plugin-restart-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const cwd = join(home, 'project')
	const root = join(cwd, '.namzu/plugins/ledger')
	const marker = join(home, 'imported.txt')
	await mkdir(root, { recursive: true })
	await writeFile(
		join(root, 'plugin.json'),
		JSON.stringify({
			name: 'ledger',
			version: '1.0.0',
			description: 'restart fixture',
			tools: ['first.mjs'],
		}),
	)
	await writeFile(join(root, 'first.mjs'), 'export const tools = []\n')
	const start = async () => {
		const runtime = (await createCliPluginRuntime(
			{ enabled: true, allowedScopes: ['project'] },
			new ToolRegistry(),
			cwd,
		))!
		runtimes.push(runtime)
		return runtime
	}
	const first = await start()
	const observer = await start()
	await first.setEnabled('ledger', false)
	expect(first.list()[0]).toMatchObject({ status: 'disabled', startupEnabled: true })
	await first.rememberState('ledger')
	expect(observer.list()[0]).toMatchObject({ status: 'enabled', startupEnabled: false })
	await observer.close()
	await first.close()
	await expect(first.rememberState('ledger')).rejects.toThrow('closed')
	// A fresh module URL proves the restart skipped executable loading, rather
	// than passing only because Node had cached the first module's evaluation.
	await writeFile(
		join(root, 'plugin.json'),
		JSON.stringify({
			name: 'ledger',
			version: '1.0.1',
			description: 'restart fixture',
			tools: ['second.mjs'],
		}),
	)
	await writeFile(
		join(root, 'second.mjs'),
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nexport const tools = [];\n`,
	)
	const second = await start()
	expect(second.list()[0]).toMatchObject({ status: 'disabled', startupEnabled: false, tools: [] })
	await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
	await second.setEnabled('ledger', false)
	await second.setEnabled('ledger', true)
	expect(await readFile(marker, 'utf8')).toBe('imported')
	expect(second.list()[0]).toMatchObject({ status: 'enabled', startupEnabled: false })
	await second.rememberState('ledger')
	await second.close()
	const third = await start()
	expect(third.list()[0]).toMatchObject({ status: 'enabled', startupEnabled: true })
	const settingsDir = join(home, 'plugin-settings')
	const record = (await readdir(settingsDir))[0]!
	await writeFile(join(settingsDir, record), '{damaged-setting')
	expect(third.list()[0]?.startupEnabled).toBeUndefined()
	expect(third.list()[0]?.startupError).toContain('Could not read plugin setting')
	expect(third.list()[0]?.status).toBe('enabled')
	await third.close()
	await expect(start()).rejects.toThrow('Could not read plugin setting')
	expect(await createCliPluginRuntime(undefined, new ToolRegistry(), cwd)).toBeUndefined()
})

it('keeps disabled hooks and MCP servers dormant while retaining manifest validation', async () => {
	const home = await mkdtemp(join(tmpdir(), 'namzu-plugin-dormant-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const rootDir = join(home, 'plugins', 'dormant')
	await mkdir(rootDir, { recursive: true })
	const manifest = {
		name: 'dormant',
		version: '1.0.0',
		description: 'must stay dormant',
		hooks: ['throw.mjs'],
		mcpServers: [{ name: 'dormant-mcp', command: 'namzu-this-command-does-not-exist' }],
	}
	await writeFile(join(rootDir, 'plugin.json'), JSON.stringify(manifest))
	await writeFile(join(rootDir, 'throw.mjs'), 'throw new Error("Hook imported while disabled");\n')
	new PluginSettingsStore(home).write({ rootDir, name: 'dormant' }, false)
	const runtime = (await createCliPluginRuntime(
		{ enabled: true, allowedScopes: ['user'] },
		new ToolRegistry(),
		home,
	))!
	runtimes.push(runtime)
	expect(runtime.list()[0]).toMatchObject({
		status: 'disabled',
		startupEnabled: false,
		scope: 'user',
	})
	await runtime.close()
	await writeFile(join(rootDir, 'plugin.json'), '{bad-json')
	await expect(
		createCliPluginRuntime({ enabled: true, allowedScopes: ['user'] }, new ToolRegistry(), home),
	).rejects.toThrow('Plugin runtime could not start')
})

it("registers the session's own skill tool for plugin skills, not a bare one", async () => {
	// The session's tool knows which directory the model can open for a skill
	// (#536); a plugin runtime registering the SDK's default in its place would
	// hand plugin skills the host path again.
	const home = await mkdtemp(join(tmpdir(), 'namzu-plugin-skill-tool-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const cwd = join(home, 'project')
	const root = join(cwd, '.namzu/plugins/ledger')
	await mkdir(join(root, 'skills', 'reconcile'), { recursive: true })
	await writeFile(
		join(root, 'plugin.json'),
		JSON.stringify({
			name: 'ledger',
			version: '1.0.0',
			description: 'skill fixture',
			skills: ['skills/reconcile'],
		}),
	)
	await writeFile(
		join(root, 'skills', 'reconcile', 'SKILL.md'),
		'---\nname: reconcile\ndescription: Reconcile ledger\n---\n\nRead ledger.\n',
	)
	const skillTool = createSkillTool({ resolveModelDirectory: () => undefined })
	const tools = new ToolRegistry()
	const runtime = (await createCliPluginRuntime(
		{ enabled: true, allowedScopes: ['project'] },
		tools,
		cwd,
		undefined,
		skillTool,
	))!
	runtimes.push(runtime)

	expect(tools.get('skill')).toBe(skillTool)
	await runtime.setEnabled('ledger', false)
	expect(tools.has('skill')).toBe(false)
	await runtime.setEnabled('ledger', true)
	expect(tools.get('skill')).toBe(skillTool)
})
