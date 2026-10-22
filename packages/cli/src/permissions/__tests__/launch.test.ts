import { describe, expect, it } from 'vitest'

import { launchRefusal, planLaunchMode } from '../launch.js'

const USER = { root: false, sandboxed: false } as const
const ROOT = { root: true, sandboxed: false } as const
const ROOT_IN_SANDBOX = { root: true, sandboxed: true } as const

const plan = (input: Parameters<typeof planLaunchMode>[0]) => {
	const result = planLaunchMode({ environment: USER, ...input })
	if ('error' in result) throw new Error(result.error)
	return result.plan
}

describe('the flags and the mode they start in', () => {
	it('starts in prompt with nothing asked for', () => {
		expect(plan({})).toEqual({ mode: 'prompt', source: 'default', bypassAvailable: false })
	})

	it.each([
		['--yolo and --dangerously-skip-permissions', { skipPermissions: true }],
		['--permission-mode bypass', { permissionModeFlag: 'bypass' }],
	])('%s start in bypass and open the door to it', (_flag, input) => {
		expect(plan(input).mode).toBe('bypass')
		expect(plan(input).bypassAvailable).toBe(true)
	})

	it('reads --permission-mode auto as the classifier', () => {
		expect(plan({ permissionModeFlag: 'auto' })).toMatchObject({ mode: 'classify' })
	})

	it('lets --allow-dangerously-skip-permissions open the door without starting in it', () => {
		expect(plan({ allowBypassFlag: true })).toEqual({
			mode: 'prompt',
			source: 'default',
			bypassAvailable: true,
		})
	})

	it('lets a named mode win over the alias, and keeps the door the alias opened', () => {
		expect(plan({ permissionModeFlag: 'plan', skipPermissions: true })).toEqual({
			mode: 'plan',
			source: 'launch-flag',
			bypassAvailable: true,
		})
	})

	it('names the words it accepts when the flag is not one', () => {
		expect(planLaunchMode({ permissionModeFlag: 'yolo', environment: USER })).toEqual({
			error:
				'--permission-mode must be one of: prompt, accept-edits, plan, bypass, auto, strict (got "yolo")',
		})
	})
})

describe('the configured default', () => {
	it('starts a session in the mode the settings name, and says it was the configuration', () => {
		expect(plan({ settings: { defaultMode: 'accept-edits' } })).toEqual({
			mode: 'accept-edits',
			source: 'config-default',
			bypassAvailable: false,
		})
	})

	it('makes bypass the default and reachable when the operator’s own file says so', () => {
		expect(plan({ settings: { defaultMode: 'bypass' } })).toEqual({
			mode: 'bypass',
			source: 'config-default',
			bypassAvailable: true,
		})
	})

	it('yields to a flag', () => {
		expect(plan({ settings: { defaultMode: 'bypass' }, permissionModeFlag: 'plan' })).toMatchObject(
			{
				mode: 'plan',
				source: 'launch-flag',
			},
		)
	})

	it('falls back to prompt, not an error, when the settings shut the default’s own door', () => {
		expect(plan({ settings: { defaultMode: 'bypass', disableBypassMode: true } })).toEqual({
			mode: 'prompt',
			source: 'default',
			bypassAvailable: false,
		})
		expect(plan({ settings: { defaultMode: 'auto', disableAutoMode: true } })).toMatchObject({
			mode: 'prompt',
		})
	})
})

describe('what the settings shut', () => {
	it.each([
		['--yolo', { skipPermissions: true }],
		['--permission-mode bypass', { permissionModeFlag: 'bypass' }],
	])('refuses %s when permissions.disableBypassMode is set', (_flag, input) => {
		const result = planLaunchMode({
			...input,
			settings: { disableBypassMode: true },
			environment: USER,
		})

		expect(result).toEqual({
			error: 'Bypass mode is turned off by permissions.disableBypassMode in your configuration.',
		})
	})

	it('does not give --allow-dangerously-skip-permissions a door the settings shut', () => {
		expect(plan({ allowBypassFlag: true, settings: { disableBypassMode: true } })).toMatchObject({
			bypassAvailable: false,
		})
	})

	it('refuses --permission-mode auto when permissions.disableAutoMode is set', () => {
		expect(
			planLaunchMode({
				permissionModeFlag: 'auto',
				settings: { disableAutoMode: true },
				environment: USER,
			}),
		).toEqual({
			error: 'Auto mode is turned off by permissions.disableAutoMode in your configuration.',
		})
	})
})

describe('the root guard', () => {
	const message =
		'Bypass mode cannot be used as the root user outside a sandbox. Run Namzu as a regular user, or inside a container or sandbox.'

	it('refuses bypass at launch as the superuser outside a sandbox', () => {
		expect(planLaunchMode({ skipPermissions: true, environment: ROOT })).toEqual({ error: message })
		expect(launchRefusal('bypass', { environment: ROOT })).toBe(message)
	})

	it('lets the superuser in a sandbox or container through', () => {
		expect(launchRefusal('bypass', { environment: ROOT_IN_SANDBOX })).toBeUndefined()
	})

	it('does not touch the modes that still ask', () => {
		for (const mode of ['prompt', 'accept-edits', 'plan', 'classify', 'strict', 'auto'] as const) {
			expect(launchRefusal(mode, { environment: ROOT })).toBeUndefined()
		}
	})

	it('takes the stop off the cycle for a root --allow-dangerously-skip-permissions', () => {
		expect(planLaunchMode({ allowBypassFlag: true, environment: ROOT })).toEqual({
			plan: { mode: 'prompt', source: 'default', bypassAvailable: false },
		})
	})

	it('does not start the configuration’s default in bypass as the superuser', () => {
		expect(plan({ settings: { defaultMode: 'bypass' }, environment: ROOT })).toMatchObject({
			mode: 'prompt',
			bypassAvailable: false,
		})
	})
})
