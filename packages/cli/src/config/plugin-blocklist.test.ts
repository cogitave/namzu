import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function load(files: { user?: string; project?: object; local?: object; managed?: object }) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (files.user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), files.user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (files.project !== undefined)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project))
	if (files.local !== undefined) {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'settings.local.json'), JSON.stringify(files.local))
	}
	const managedPath = join(cwd, 'managed.json')
	if (files.managed !== undefined) writeFileSync(managedPath, JSON.stringify(files.managed))
	return loadConfig({ home, cwd, env: {}, managedPath })
}

describe('plugins.blockedMarketplaces', () => {
	it('reads a list from the user file and from the managed file', () => {
		expect(
			load({ user: 'plugins:\n  blockedMarketplaces:\n    - acme/tools\n    - example.com/*\n' })
				.plugins,
		).toEqual({
			blockedMarketplaces: ['acme/tools', 'example.com/*'],
		})
		expect(
			load({ managed: { plugins: { blockedMarketplaces: ['evil/*'] } } }).plugins
				?.blockedMarketplaces,
		).toEqual(['evil/*'])
	})

	it('only grows across layers: a managed file that sets other plugin keys keeps what the user blocked', () => {
		const config = load({
			user: 'plugins:\n  enabled: true\n  blockedMarketplaces: [acme/tools, shared/one]\n',
			managed: { plugins: { hookTimeoutMs: 5000, blockedMarketplaces: ['evil/*', 'shared/one'] } },
		})
		expect(config.plugins).toEqual({
			hookTimeoutMs: 5000,
			blockedMarketplaces: ['acme/tools', 'shared/one', 'evil/*'],
		})
	})

	it('is dropped from a project file and from a local file: a repository cannot set it', () => {
		const config = load({
			user: 'plugins:\n  enabled: true\n',
			project: { plugins: { blockedMarketplaces: ['*'], enabled: true } },
			local: { plugins: { blockedMarketplaces: ['*'] } },
		})
		expect(config.plugins?.blockedMarketplaces).toBeUndefined()
	})

	it('refuses a value that is not a list of addresses', () => {
		for (const bad of [
			'plugins:\n  blockedMarketplaces: acme/tools\n',
			'plugins:\n  blockedMarketplaces: [1]\n',
			'plugins:\n  blockedMarketplaces: [""]\n',
		]) {
			expect(() => load({ user: bad }), bad).toThrow(ConfigValueError)
		}
	})
})
