import { describe, expect, it } from 'vitest'

import { resolveUpdatePolicy, runsInCi } from './policy.js'

const at = (
	env: NodeJS.ProcessEnv,
	config?: Parameters<typeof resolveUpdatePolicy>[0]['config'],
	interactive = true,
) => resolveUpdatePolicy({ env, config, interactive })

describe('the update policy', () => {
	it('installs quietly for a person at a terminal by default, on the latest channel', () => {
		expect(at({})).toEqual({ check: true, install: true, channel: 'latest', decidedBy: 'default' })
	})

	it('does not install in CI unless asked, but still looks', () => {
		for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CI: '1' }]) {
			expect(at(env)).toMatchObject({ check: true, install: false, decidedBy: 'ci' })
		}
		expect(runsInCi({ CI: 'false' })).toBe(false)
		expect(runsInCi({ CI: '0' })).toBe(false)
	})

	it('does not install without a terminal', () => {
		expect(at({}, undefined, false)).toMatchObject({ install: false })
	})

	it('installs in CI when the environment asks, and so does the config', () => {
		expect(at({ CI: 'true', NAMZU_AUTO_UPDATE: '1' })).toMatchObject({
			install: true,
			decidedBy: 'environment',
		})
		expect(at({ CI: 'true' }, { auto: true })).toMatchObject({ install: true, decidedBy: 'config' })
	})

	it.each(['0', 'false', 'no', 'off', ' OFF '])(
		'turns installing off for NAMZU_AUTO_UPDATE=%j',
		(word) => {
			expect(at({ NAMZU_AUTO_UPDATE: word })).toMatchObject({ check: true, install: false })
		},
	)

	it('lets the environment beat the config in both directions', () => {
		expect(at({ NAMZU_AUTO_UPDATE: 'on' }, { auto: false })).toMatchObject({ install: true })
		expect(at({ NAMZU_AUTO_UPDATE: 'off' }, { auto: true })).toMatchObject({ install: false })
	})

	it('stops looking altogether when checking is off', () => {
		expect(at({ NAMZU_UPDATE_CHECK: '0' })).toMatchObject({ check: false, install: false })
		expect(at({}, { check: false, auto: true })).toMatchObject({ check: false, install: false })
	})

	it('follows the stable channel when asked and ignores an unknown channel name', () => {
		expect(at({}, { channel: 'stable' }).channel).toBe('stable')
		expect(at({ NAMZU_UPDATE_CHANNEL: 'stable' }).channel).toBe('stable')
		expect(at({ NAMZU_UPDATE_CHANNEL: 'next' }, { channel: 'stable' }).channel).toBe('stable')
		expect(at({ NAMZU_UPDATE_CHANNEL: 'latest' }, { channel: 'stable' }).channel).toBe('latest')
		expect(at({ NAMZU_UPDATE_CHANNEL: 'next' }).channel).toBe('latest')
	})
})
