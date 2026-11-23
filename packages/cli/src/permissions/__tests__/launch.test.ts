import { describe, expect, it } from 'vitest'

import { defaultStartMode, launchRefusal, planLaunchMode } from '../launch.js'
import {
	type PermissionSettings,
	mergePermissionSettings,
	splitPermissionsTable,
} from '../settings.js'

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
		['--dangerously-skip-permissions', { skipPermissions: true }],
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

describe('the bypass opt-in', () => {
	it('makes bypass reachable without starting in it', () => {
		expect(plan({ settings: { allowBypassMode: true } })).toEqual({
			mode: 'prompt',
			source: 'default',
			bypassAvailable: true,
		})
	})

	it('is overruled by the forbid key', () => {
		expect(
			plan({ settings: { allowBypassMode: true, disableBypassMode: true } }).bypassAvailable,
		).toBe(false)
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
		['--dangerously-skip-permissions', { skipPermissions: true }],
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

describe('auto as the interactive terminal’s default', () => {
	const interactive = (input: Parameters<typeof planLaunchMode>[0] = {}) =>
		plan({ interactive: true, ...input })

	it('starts in auto with nothing chosen, and says the default chose it', () => {
		expect(interactive()).toEqual({
			mode: 'classify',
			source: 'auto-default',
			bypassAvailable: false,
		})
	})

	it.each([
		['--permission-mode prompt', { permissionModeFlag: 'prompt' }, 'prompt', 'launch-flag'],
		['--permission-mode auto', { permissionModeFlag: 'auto' }, 'classify', 'launch-flag'],
		['--dangerously-skip-permissions', { skipPermissions: true }, 'bypass', 'launch-bypass'],
		['defaultMode: prompt', { settings: { defaultMode: 'prompt' } }, 'prompt', 'config-default'],
		[
			'defaultMode: accept-edits',
			{ settings: { defaultMode: 'accept-edits' } },
			'accept-edits',
			'config-default',
		],
		['defaultMode: auto', { settings: { defaultMode: 'auto' } }, 'classify', 'config-default'],
		[
			'a defaultMode the settings shut',
			{ settings: { defaultMode: 'bypass', disableBypassMode: true } },
			'prompt',
			'default',
		],
		['disableAutoMode', { settings: { disableAutoMode: true } }, 'prompt', 'default'],
	] as const)('does not apply over %s', (_what, input, mode, source) => {
		expect(interactive(input as Parameters<typeof planLaunchMode>[0])).toMatchObject({
			mode,
			source,
		})
	})

	it('is not the default anywhere but the interactive terminal', () => {
		expect(plan({})).toEqual({ mode: 'prompt', source: 'default', bypassAvailable: false })
		expect(plan({ interactive: false })).toMatchObject({ mode: 'prompt', source: 'default' })
	})

	describe('read from every layer the configuration has', () => {
		const layered = (...tables: [Record<string, unknown>, 'operator' | 'workspace'][]) =>
			tables.reduce<PermissionSettings | undefined>(
				(merged, [table, authority]) =>
					mergePermissionSettings(
						merged,
						splitPermissionsTable(table, authority, 'a file').settings,
					),
				undefined,
			)

		it.each([
			['the user file', [[{ defaultMode: 'prompt' }, 'operator']]],
			[
				'the managed file',
				[
					[{}, 'operator'],
					[{ defaultMode: 'plan' }, 'operator'],
				],
			],
			[
				'the project file',
				[
					[{}, 'operator'],
					[{ defaultMode: 'prompt' }, 'workspace'],
				],
			],
		] as const)('a defaultMode in %s keeps the configured mode', (_where, tables) => {
			const settings = layered(
				...(tables as unknown as [Record<string, unknown>, 'operator' | 'workspace'][]),
			)
			expect(interactive({ settings }).source).toBe('config-default')
		})

		it.each([
			[
				'the user file',
				[
					[{ disableAutoMode: true }, 'operator'],
					[{}, 'workspace'],
				],
			],
			[
				'the project file',
				[
					[{}, 'operator'],
					[{ disableAutoMode: true }, 'workspace'],
				],
			],
			[
				'one layer, whatever a later one says',
				[
					[{ disableAutoMode: true }, 'operator'],
					[{ disableAutoMode: false }, 'workspace'],
				],
			],
		] as const)('disableAutoMode in %s starts the terminal asking', (_where, tables) => {
			const settings = layered(
				...(tables as unknown as [Record<string, unknown>, 'operator' | 'workspace'][]),
			)
			expect(interactive({ settings })).toMatchObject({ mode: 'prompt', source: 'default' })
		})

		it('lets the default stand where a project wrote a mode it may not choose', () => {
			// A project cannot make a no-asking mode its default; that does not
			// make it the one to say the terminal starts by asking either.
			const settings = layered([{}, 'operator'], [{ defaultMode: 'bypass' }, 'workspace'])
			expect(settings?.ignored?.[0]).toContain('is ignored')
			expect(interactive({ settings }).source).toBe('auto-default')
		})
	})
})

describe('the mode a defaulted session starts in once it is built', () => {
	it('is auto when the default chose it and the classifier can reach a model', () => {
		expect(defaultStartMode({ pal: false, autoDefault: true, classifierUsable: true })).toBe(
			'classify',
		)
	})

	it('is prompt, without a word, when the classifier cannot reach a model', () => {
		expect(defaultStartMode({ pal: false, autoDefault: true, classifierUsable: false })).toBe(
			'prompt',
		)
	})

	it('is prompt when the settings switched auto off or named a default since', () => {
		for (const settings of [{ disableAutoMode: true }, { defaultMode: 'prompt' as const }]) {
			expect(
				defaultStartMode({ pal: false, autoDefault: true, settings, classifierUsable: true }),
			).toBe('prompt')
		}
	})

	it('is prompt when the launch did not leave the choice to the default', () => {
		expect(defaultStartMode({ pal: false, autoDefault: false, classifierUsable: true })).toBe(
			'prompt',
		)
	})

	it('is the unattended mode for a Pal, whatever else holds', () => {
		expect(defaultStartMode({ pal: true, autoDefault: true, classifierUsable: true })).toBe('auto')
		expect(defaultStartMode({ pal: true, autoDefault: false, classifierUsable: false })).toBe(
			'auto',
		)
	})
})
