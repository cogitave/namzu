import { describe, expect, it } from 'vitest'

import { decideTeams, teamsEnabled, teamsLimits } from './enabled.js'

const gate = (
	config: { enabled?: boolean } | undefined,
	env: NodeJS.ProcessEnv = {},
	interactive = true,
) => ({ config: () => config, env: () => env, interactive })

describe('teams gate', () => {
	it('is off by default', () => {
		const decision = decideTeams(gate(undefined))
		expect(decision).toMatchObject({ enabled: false, reason: 'disabled' })
		expect(teamsEnabled(gate({}))).toBe(false)
	})

	it('turns on from the setting or from NAMZU_TEAMS', () => {
		expect(decideTeams(gate({ enabled: true }))).toEqual({ enabled: true, source: 'setting' })
		expect(decideTeams(gate(undefined, { NAMZU_TEAMS: '1' }))).toEqual({
			enabled: true,
			source: 'env',
		})
		expect(teamsEnabled(gate(undefined, { NAMZU_TEAMS: 'ON' }))).toBe(true)
	})

	it('treats NAMZU_TEAMS=0 as a hard stop over the setting', () => {
		expect(decideTeams(gate({ enabled: true }, { NAMZU_TEAMS: '0' }))).toMatchObject({
			enabled: false,
			reason: 'env-off',
		})
		expect(teamsEnabled(gate({ enabled: true }, { NAMZU_TEAMS: 'false' }))).toBe(false)
	})

	it('never runs headless, whatever is set', () => {
		expect(decideTeams(gate({ enabled: true }, { NAMZU_TEAMS: '1' }, false))).toMatchObject({
			enabled: false,
			reason: 'headless',
		})
	})

	it('reads the setting and the environment again on every call', () => {
		const live: { config: { enabled?: boolean } | undefined; env: NodeJS.ProcessEnv } = {
			config: undefined,
			env: {},
		}
		const input = { config: () => live.config, env: () => live.env, interactive: true }
		expect(teamsEnabled(input)).toBe(false)
		live.config = { enabled: true }
		expect(teamsEnabled(input)).toBe(true)
		live.env = { NAMZU_TEAMS: '0' }
		expect(teamsEnabled(input)).toBe(false)
	})

	it('has limits of 5 teammates, 30 idle minutes and a 20 second shutdown wait unless set', () => {
		expect(teamsLimits(undefined)).toEqual({
			maxTeammates: 5,
			idleExitMinutes: 30,
			shutdownGraceSeconds: 20,
		})
		expect(teamsLimits({ maxTeammates: 3, idleExitMinutes: 10, shutdownGraceSeconds: 5 })).toEqual({
			maxTeammates: 3,
			idleExitMinutes: 10,
			shutdownGraceSeconds: 5,
		})
	})
})
