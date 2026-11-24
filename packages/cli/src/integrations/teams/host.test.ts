import { describe, expect, it } from 'vitest'

import type { TeamsConfig } from '../../config/schema.js'
import { createTeamsHost } from './host.js'

describe('the teams host a session builds', () => {
	it('asks the setting again at every call, so a change applies to the next one', () => {
		let config: TeamsConfig | undefined
		const host = createTeamsHost({ config: () => config, env: () => ({}) })
		expect(host.enabled()).toMatchObject({ enabled: false, reason: 'disabled' })
		config = { enabled: true }
		expect(host.enabled()).toMatchObject({ enabled: true })
		config = { enabled: true, maxTeammates: 3, idleExitMinutes: 2 }
		expect(host.limits()).toEqual({ maxTeammates: 3, idleExitMinutes: 2 })
	})

	it('NAMZU_TEAMS=0 stops it whatever the setting says', () => {
		const host = createTeamsHost({
			config: () => ({ enabled: true }),
			env: () => ({ NAMZU_TEAMS: '0' }),
		})
		expect(host.enabled()).toMatchObject({ enabled: false, reason: 'env-off' })
	})

	it('gives one shared list per team, the same object each time', () => {
		const host = createTeamsHost({ config: () => undefined, env: () => ({}) })
		expect(host.taskStoreFor('team-aaaa1111')).toBe(host.taskStoreFor('team-aaaa1111'))
		expect(host.taskStoreFor('team-aaaa1111')).not.toBe(host.taskStoreFor('team-bbbb2222'))
	})
})
