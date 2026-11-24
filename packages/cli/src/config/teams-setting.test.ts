import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'
import { findSetting } from './setting-cli.js'

function load(user?: string, project?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (project !== undefined) {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'config.yaml'), project)
	}
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('teams settings', () => {
	it('are absent by default, which means off', () => {
		expect(load().teams).toBeUndefined()
	})

	it('read as written, and "true" from the Settings screen reads as the boolean', () => {
		expect(
			load('teams:\n  enabled: true\n  maxTeammates: 3\n  idleExitMinutes: 10\n').teams,
		).toEqual({
			enabled: true,
			maxTeammates: 3,
			idleExitMinutes: 10,
		})
		expect(load('teams:\n  enabled: "true"\n').teams).toEqual({ enabled: true })
	})

	it('refuse values that are not whole numbers in range, or unknown keys', () => {
		for (const bad of [
			'teams:\n  enabled: sometimes\n',
			'teams:\n  maxTeammates: 0\n',
			'teams:\n  maxTeammates: 17\n',
			'teams:\n  maxTeammates: 2.5\n',
			'teams:\n  idleExitMinutes: 1441\n',
			'teams:\n  mode: process\n',
			'teams: yes\n',
		])
			expect(() => load(bad), bad).toThrow(ConfigValueError)
	})

	it('are your own: a repository cannot start helpers that spend your limit', () => {
		const config = load(
			'teams:\n  maxTeammates: 2\n',
			'teams:\n  enabled: true\n  maxTeammates: 16\n',
		)
		expect(config.teams).toEqual({ maxTeammates: 2 })
	})

	it('have a row each in Settings, off and 5 and 30 by default', () => {
		for (const key of ['teams.enabled', 'teams.maxTeammates', 'teams.idleExitMinutes']) {
			const row = findSetting(key)
			expect(row, key).toBeDefined()
			expect(row?.keywords, key).toContain('teams')
		}
		expect(findSetting('teams.enabled')?.default).toBe(false)
		expect(findSetting('teams.maxTeammates')?.default).toBe(5)
		expect(findSetting('teams.idleExitMinutes')?.default).toBe(30)
	})
})
