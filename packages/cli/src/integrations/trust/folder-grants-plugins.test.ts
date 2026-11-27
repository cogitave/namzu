import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installFixture } from '../../__fixtures__/installed-plugin.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { trustGrantLines } from '../../tui/TrustPrompt.js'
import { readFolderGrants } from './folder-grants.js'

let root: string
let home: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-grants-plugins-'))
	home = join(root, 'home')
	cwd = join(root, 'app')
	mkdirSync(home, { recursive: true })
	mkdirSync(join(cwd, '.namzu'), { recursive: true })
})
afterEach(() => removeTempDir(root))

describe('the trust screen and the plugin records', () => {
	it('says which asked-for plugins are installed here, which are not, and what is turned off', () => {
		installFixture(home, { id: 'have@m' })
		installFixture(home, { id: 'quiet@m' })
		writeFileSync(
			join(cwd, '.namzu', 'settings.json'),
			JSON.stringify({
				enabledPlugins: { 'have@m': true, 'missing@m': true, 'quiet@m': false },
				extraKnownMarketplaces: { team: { source: { source: 'github', repo: 'acme/team' } } },
			}),
		)
		const grants = readFolderGrants(cwd, home)
		expect(grants.pluginRecords).toEqual([
			{ id: 'have@m', layer: 'project', on: true, installed: true },
			{ id: 'missing@m', layer: 'project', on: true, installed: false },
			{ id: 'quiet@m', layer: 'project', on: false, installed: true },
		])
		expect(grants.marketplaces).toEqual([{ name: 'team', from: 'github acme/team' }])
		const lines = trustGrantLines(grants, 100).join('\n')
		expect(lines).toContain('have@m: installed on this computer')
		expect(lines).toContain('missing@m: asked for here and not installed on this computer')
		expect(lines).toContain('quiet@m: turned off here')
		expect(lines).toContain('team: github acme/team')
		expect(lines).toContain('suggestions, none is added')
	})

	it('lists the hook commands an installed plugin turned on here would run', () => {
		const fixture = installFixture(home, { id: 'guard@m' })
		// A surface that names a hook; the digest is not checked by the screen.
		const manifestPath = join(home, 'plugins', '.install-manifests', 'guard@m.json')
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
		manifest.surface.hooks = [
			{ event: 'PreToolUse', matcher: 'Bash', command: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh' },
		]
		writeFileSync(manifestPath, JSON.stringify(manifest))
		expect(fixture.id).toBe('guard@m')
		writeFileSync(
			join(cwd, '.namzu', 'settings.local.json'),
			JSON.stringify({ enabledPlugins: { 'guard@m': true } }),
		)
		const grants = readFolderGrants(cwd, home)
		expect(grants.hooks).toContainEqual({
			event: 'PreToolUse',
			runs: '${NAMZU_PLUGIN_ROOT}/scripts/guard.sh (plugin guard)',
		})
	})

	it('shows nothing about plugins for a folder whose files name none', () => {
		writeFileSync(join(cwd, '.namzu', 'settings.json'), JSON.stringify({ permissions: {} }))
		const grants = readFolderGrants(cwd, home)
		expect(grants.pluginRecords ?? []).toEqual([])
		expect(trustGrantLines(grants, 100)).toEqual([])
	})

	it('grants nothing when the settings files do not read', () => {
		writeFileSync(join(cwd, '.namzu', 'settings.json'), '{ nope')
		expect(readFolderGrants(cwd, home).pluginRecords ?? []).toEqual([])
	})
})
