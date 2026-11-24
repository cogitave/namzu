import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig } from '../config/load.js'
import { decideTeams } from '../integrations/teams/enabled.js'
import { launchLayersFor } from './launch-extras.js'

function load(layers: ReturnType<typeof launchLayersFor>, managed?: string) {
	if ('error' in layers) throw new Error(layers.error)
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	const managedPath = join(cwd, 'managed.json')
	if (managed !== undefined) writeFileSync(managedPath, managed)
	return loadConfig({ home, cwd, env: {}, managedPath, launchLayers: layers.layers })
}

describe('--teams', () => {
	it('adds no layer unless it is given', () => {
		expect(launchLayersFor({})).toEqual({ layers: [] })
		expect(launchLayersFor({ teams: false })).toEqual({ layers: [] })
	})

	it('is a settings layer that turns teams.enabled on for the launch', () => {
		const layers = launchLayersFor({ teams: true })
		expect('error' in layers).toBe(false)
		const config = load(layers)
		expect(config.teams).toEqual({ enabled: true })
		expect(decideTeams({ config: () => config.teams, env: () => ({}), interactive: true })).toEqual(
			{ enabled: true, source: 'setting' },
		)
	})

	it('does nothing in a headless run', () => {
		const config = load(launchLayersFor({ teams: true }))
		expect(
			decideTeams({ config: () => config.teams, env: () => ({}), interactive: false }),
		).toMatchObject({ enabled: false, reason: 'headless' })
	})

	it('loses to the managed file and to NAMZU_TEAMS=0', () => {
		const managed = load(launchLayersFor({ teams: true }), '{"teams":{"enabled":false}}')
		expect(managed.teams?.enabled).toBe(false)
		const config = load(launchLayersFor({ teams: true }))
		expect(
			decideTeams({
				config: () => config.teams,
				env: () => ({ NAMZU_TEAMS: '0' }),
				interactive: true,
			}),
		).toMatchObject({ enabled: false, reason: 'env-off' })
	})
})
