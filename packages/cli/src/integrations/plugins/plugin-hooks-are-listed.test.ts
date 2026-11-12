import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { type CliPluginRuntime, createCliPluginRuntime } from './runtime.js'

const roots: string[] = []
const runtimes: CliPluginRuntime[] = []
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.unstubAllEnvs()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('lists the JavaScript hooks a plugin registered with its name, and not the shell hooks', async () => {
	const home = await mkdtemp(join(tmpdir(), 'namzu-plugin-hooks-'))
	roots.push(home)
	vi.stubEnv('NAMZU_HOME', home)
	const cwd = join(home, 'project')
	const root = join(cwd, '.namzu/plugins/review-bot')
	await mkdir(root, { recursive: true })
	await writeFile(
		join(root, 'plugin.json'),
		JSON.stringify({
			name: 'review-bot',
			version: '1.0.0',
			description: 'hook listing fixture',
			hooks: ['hooks.mjs'],
		}),
	)
	await writeFile(
		join(root, 'hooks.mjs'),
		[
			'export const hooks = [',
			"  { event: 'pre_tool_use', handler: async () => ({ action: 'continue' }) },",
			"  { event: 'turn_end', handler: async () => ({ action: 'continue' }) },",
			']',
			'',
		].join('\n'),
	)
	const runtime = (await createCliPluginRuntime(
		{ enabled: true, allowedScopes: ['project'] },
		cwd,
		{ session_start: [{ command: 'true' }] },
	))!
	runtimes.push(runtime)
	expect(runtime.pluginHooks()).toEqual([
		{ plugin: 'review-bot', event: 'pre_tool_use' },
		{ plugin: 'review-bot', event: 'turn_end' },
	])
})
