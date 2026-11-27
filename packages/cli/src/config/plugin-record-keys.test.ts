import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { makeTempDir } from '../__fixtures__/temp-dir.js'
import { KNOWN_FILE_KEYS, PLUGIN_RECORD_KEYS, loadConfigWithProvenance } from './load.js'

function load(files: { project?: unknown }) {
	const root = makeTempDir('namzu-record-keys-')
	const home = join(root, 'home')
	const cwd = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	if (files.project !== undefined)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project), 'utf-8')
	return loadConfigWithProvenance({ home, cwd, managedPath: join(root, 'none.json'), env: {} })
}

describe('the plugin record keys of a settings file', () => {
	it('are known file keys that are not config settings', () => {
		for (const key of PLUGIN_RECORD_KEYS) expect(KNOWN_FILE_KEYS).toContain(key)
	})

	it('leave config untouched when a file carries them', () => {
		const { config } = load({
			project: { quiet: true, enabledPlugins: { 'a@m': true }, extraKnownMarketplaces: {} },
		})
		expect(config.quiet).toBe(true)
		expect('enabledPlugins' in config).toBe(false)
		expect('extraKnownMarketplaces' in config).toBe(false)
	})

	it('may not be declared inside a profile', () => {
		for (const key of PLUGIN_RECORD_KEYS) {
			expect(() => load({ project: { profiles: { ci: { [key]: {} } } } })).toThrow(
				new RegExp(`profiles\\.ci\\.${key} cannot be declared inside a profile`),
			)
		}
	})
})
