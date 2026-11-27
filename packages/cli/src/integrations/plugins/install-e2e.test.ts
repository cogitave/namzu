import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MANIFEST, makeMarketplace, makePlugin, skill } from '../../__fixtures__/plugin-source.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { runMarketplace, runPluginInstall } from '../../commands/plugin-install.js'
import type { PluginInstallDeps } from '../../commands/plugin-install.js'
import { type CliPluginRuntime, createCliPluginRuntime } from './runtime.js'

let root: string
let home: string
let cwd: string
const runtimes: CliPluginRuntime[] = []

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-install-e2e-'))
	home = join(root, 'home')
	cwd = realpathSync(mkdirSync(join(root, 'app'), { recursive: true }) ?? join(root, 'app'))
	mkdirSync(home, { recursive: true })
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(async () => {
	for (const runtime of runtimes.splice(0)) await runtime.close()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function deps(): PluginInstallDeps {
	return {
		out: () => undefined,
		err: () => undefined,
		cwd: () => cwd,
		namzuHome: home,
		isTrusted: () => true,
		loadingOn: true,
		interactive: false,
		ask: async () => false,
		now: () => new Date('2026-11-27T10:00:00.000Z'),
		enableLoading: () => 'on',
	}
}

async function start(): Promise<CliPluginRuntime> {
	const runtime = await createCliPluginRuntime({ enabled: true }, cwd, undefined, undefined, {
		projectTrusted: true,
	})
	if (!runtime) throw new Error('no runtime')
	runtimes.push(runtime)
	return runtime
}

describe('a plugin installed through a local marketplace loads through the runtime', () => {
	it('is admitted from its cache folder with its skill, and stops when a script changes', async () => {
		const dir = join(root, 'team')
		makePlugin(join(dir, 'plugins/ledger'), 'ledger', {
			files: {
				[MANIFEST]: { name: 'ledger', version: '1.2.0', description: 'Books.' },
				'skills/reconcile/SKILL.md': skill('reconcile'),
				'commands/close.md': 'Close the books.',
				'hooks/hooks.json': {
					hooks: {
						PreToolUse: [
							{
								matcher: 'Bash',
								hooks: [{ type: 'command', command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' }],
							},
						],
					},
				},
				'scripts/guard.sh': '#!/bin/sh\nexit 0\n',
			},
		})
		makeMarketplace(dir, 'team', [{ name: 'ledger', source: './plugins/ledger' }])
		expect(await runMarketplace(['add', dir], deps())).toBe(0)
		expect(await runPluginInstall('install', ['ledger@team', '--yes'], deps())).toBe(0)

		const runtime = await start()
		expect(runtime.list()).toEqual([
			expect.objectContaining({
				name: 'ledger',
				status: 'enabled',
				installId: 'ledger@team',
				installScope: 'user',
				skills: ['ledger__reconcile'],
				rootDir: realpathSync(join(home, 'plugins', 'cache', 'team', 'ledger', '1.2.0')),
			}),
		])
		expect(runtime.installedProblems()).toEqual([])
		await runtime.close()
		runtimes.pop()

		writeFileSync(
			join(home, 'plugins', 'cache', 'team', 'ledger', '1.2.0', 'scripts', 'guard.sh'),
			'#!/bin/sh\necho hi\n',
		)
		const tampered = await start()
		expect(tampered.list()).toEqual([])
		expect(tampered.installedProblems()[0]?.message).toContain(
			'ledger changed on disk after you accepted it',
		)
	})

	it('loads a plugin from an upload, and removes it again', async () => {
		const plugin = makePlugin(join(root, 'up/solo'), 'solo', {
			files: {
				[MANIFEST]: { name: 'solo', version: '1.0.0', description: 'Solo.' },
				'skills/a/SKILL.md': skill('a'),
			},
		})
		expect(await runPluginInstall('install', [plugin, '--yes'], deps())).toBe(0)
		const runtime = await start()
		expect(runtime.list()[0]).toMatchObject({
			name: 'solo',
			installId: 'solo@local-uploads',
			status: 'enabled',
		})
		await runtime.close()
		runtimes.pop()
		expect(await runPluginInstall('uninstall', ['solo@local-uploads'], deps())).toBe(0)
		expect((await start()).list()).toEqual([])
	})
})
