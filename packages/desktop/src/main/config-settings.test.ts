import { describe, expect, it, vi } from 'vitest'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import { ConfigSettings } from './config-settings.js'

const view: ConfigSettingsView = {
	file: '/x/config.yaml',
	descriptors: [
		{
			path: 'quiet',
			label: 'Quiet',
			description: 'x',
			section: 'general',
			control: { kind: 'toggle' },
		},
		{
			path: 'sandbox.enabled',
			label: 'Sandbox',
			description: 'x',
			section: 'projects',
			control: { kind: 'toggle' },
			confirm: 'Without a sandbox, commands run directly.',
			confirmWhen: 'off',
		},
		{
			path: 'limits.maxIterations',
			label: 'Steps',
			description: 'x',
			section: 'agent',
			control: { kind: 'number' },
			confirm: 'No limit means no stop.',
			confirmWhen: 'zero',
		},
		{
			path: 'permissions.outsideRoot',
			label: 'Outside',
			description: 'x',
			section: 'projects',
			control: {
				kind: 'select',
				options: [
					{ value: 'ask', label: 'Ask' },
					{ value: 'refuse', label: 'Refuse' },
				],
			},
			confirm: 'Namzu will ask again.',
			confirmValue: 'ask',
		},
		{
			path: 'permissions.defaultMode',
			label: 'Mode',
			description: 'x',
			section: 'projects',
			control: {
				kind: 'select',
				options: [
					{ value: 'prompt', label: 'Prompt' },
					{ value: 'bypass', label: 'Bypass' },
				],
			},
			default: 'prompt',
			confirm: 'Bypass runs everything.',
			confirmValues: ['bypass'],
		},
		{
			path: 'web.search',
			label: 'Search',
			description: 'x',
			section: 'projects',
			control: {
				kind: 'select',
				options: [
					{ value: 'live', label: 'Live' },
					{ value: 'off', label: 'Off' },
				],
			},
			default: 'live',
			confirm: 'Live search sends queries out.',
			confirmValues: ['live'],
		},
		{
			path: 'permissions',
			label: 'Rules',
			description: 'x',
			section: 'projects',
			control: { kind: 'json', example: '{}' },
			confirm: 'Rules can let tools run.',
		},
		{
			path: 'additionalDirectories',
			label: 'Folders',
			description: 'x',
			section: 'projects',
			control: { kind: 'list', itemLabel: 'folder', picker: 'folder' },
			default: [],
			confirm: 'Namzu will be able to reach this folder in every project.',
			confirmWhen: 'widens',
		},
	],
	settings: [{ path: 'additionalDirectories', set: true, value: ['/a', '/b'] }],
}

function build() {
	const write = vi.fn(async () => view)
	const validate = vi.fn(async () => {})
	return {
		write,
		validate,
		settings: new ConfigSettings({ read: async () => view, write, validate }),
	}
}

describe('changing an engine setting', () => {
	it('applies an ordinary setting at once', async () => {
		const { settings, write } = build()
		expect((await settings.change('w1', { path: 'quiet', value: true })).status).toBe('saved')
		expect(write).toHaveBeenCalledWith('quiet', true)
	})

	it('asks first for a risky one, and writes nothing until confirmed', async () => {
		const { settings, write } = build()
		const first = await settings.change('w1', { path: 'sandbox.enabled', value: false })
		expect(first.status).toBe('confirm')
		if (first.status !== 'confirm') return
		expect(first.message).toMatch(/sandbox/)
		expect(write).not.toHaveBeenCalled()
		expect(
			(await settings.change('w1', { path: 'sandbox.enabled', value: false }, first.token)).status,
		).toBe('saved')
		expect(write).toHaveBeenCalledTimes(1)
	})

	it('binds the token to the window, the setting and the value, once', async () => {
		const { settings, write } = build()
		const first = await settings.change('w1', { path: 'sandbox.enabled', value: false })
		if (first.status !== 'confirm') throw new Error('expected a confirmation')
		await expect(
			settings.change('w2', { path: 'sandbox.enabled', value: false }, first.token),
		).rejects.toThrow(/expired/)
		await expect(
			settings.change('w1', { path: 'sandbox.enabled', value: false, extra: 1 }, first.token),
		).rejects.toThrow()
		const rules = await settings.change('w1', { path: 'permissions', value: '{"a":1}' })
		if (rules.status !== 'confirm') throw new Error('expected a confirmation')
		await expect(
			settings.change('w1', { path: 'permissions', value: '{"a":2}' }, rules.token),
		).rejects.toThrow(/expired/)
		expect(write).not.toHaveBeenCalled()
	})

	it('asks only for the direction that widens', async () => {
		const { settings, write } = build()
		expect((await settings.change('w1', { path: 'sandbox.enabled', value: true })).status).toBe(
			'saved',
		)
		expect((await settings.change('w1', { path: 'limits.maxIterations', value: 20 })).status).toBe(
			'saved',
		)
		expect((await settings.change('w1', { path: 'limits.maxIterations', value: 0 })).status).toBe(
			'confirm',
		)
		expect(write).toHaveBeenCalledTimes(2)
	})

	it('asks for a select only when it picks the value that widens', async () => {
		const { settings } = build()
		expect(
			(await settings.change('w1', { path: 'permissions.outsideRoot', value: 'refuse' })).status,
		).toBe('saved')
		expect(
			(await settings.change('w1', { path: 'permissions.outsideRoot', value: 'ask' })).status,
		).toBe('confirm')
	})

	it('asks before a clear of a setting that has a confirmation', async () => {
		const { settings, write } = build()
		const first = await settings.change('w1', { path: 'sandbox.enabled' })
		expect(first.status).toBe('confirm')
		expect(write).not.toHaveBeenCalled()
		if (first.status !== 'confirm') return
		expect((await settings.change('w1', { path: 'sandbox.enabled' }, first.token)).status).toBe(
			'saved',
		)
		expect(write).toHaveBeenCalledWith('sandbox.enabled', undefined)
	})

	it('does not ask on a clear that returns to a safe default, and asks when the default is risky', async () => {
		const { settings, write } = build()
		expect((await settings.change('w1', { path: 'permissions.defaultMode' })).status).toBe('saved')
		expect(write).toHaveBeenCalledWith('permissions.defaultMode', undefined)
		expect((await settings.change('w1', { path: 'web.search' })).status).toBe('confirm')
	})

	it('does not ask on a clear that puts a switch back to the side that never asks, and asks when the default is the risky side', async () => {
		const toggle = (path: string, confirmWhen: 'on' | 'off', fallback: boolean) => ({
			path,
			label: path,
			description: 'x',
			section: 'agent' as const,
			control: { kind: 'toggle' as const },
			confirm: 'Are you sure?',
			confirmWhen,
			default: fallback,
		})
		const wide: ConfigSettingsView = {
			file: '/f',
			descriptors: [
				toggle('hypermode', 'on', false),
				toggle('limits.doneGate', 'off', true),
				toggle('sandbox.enabled', 'off', false),
			],
			settings: [],
		}
		const write = vi.fn(async () => wide)
		const settings = new ConfigSettings({ read: async () => wide, write, validate: async () => {} })
		expect((await settings.change('w1', { path: 'hypermode' })).status).toBe('saved')
		expect((await settings.change('w1', { path: 'limits.doneGate' })).status).toBe('saved')
		// Its default is the side that asks, so the clear asks too.
		expect((await settings.change('w1', { path: 'sandbox.enabled' })).status).toBe('confirm')
	})

	it('refuses a bad value before it shows a dialog', async () => {
		const validate = vi.fn(async () => {
			throw new Error('That is not valid JSON')
		})
		const write = vi.fn(async () => view)
		const settings = new ConfigSettings({ read: async () => view, write, validate })
		await expect(settings.change('w1', { path: 'permissions', value: '{bad' })).rejects.toThrow(
			/not valid JSON/,
		)
		expect(write).not.toHaveBeenCalled()
	})

	it('refuses a setting the engine did not describe', async () => {
		const { settings } = build()
		await expect(settings.change('w1', { path: 'mcpServers.x.env', value: 'y' })).rejects.toThrow(
			/not a setting/,
		)
	})

	it('lets the engine refuse a bad value, and passes its sentence on', async () => {
		const write = vi.fn(async () => {
			throw new Error('workflow.maxConcurrency must be between 2 and 16')
		})
		const settings = new ConfigSettings({ read: async () => view, write, validate: async () => {} })
		await expect(settings.change('w1', { path: 'quiet', value: 9 })).rejects.toThrow(
			/between 2 and 16/,
		)
	})
})

describe('asking only for the risky direction', () => {
	const modes = {
		path: 'permissions.defaultMode',
		label: 'Mode',
		description: 'x',
		section: 'projects' as const,
		control: {
			kind: 'select' as const,
			options: ['prompt', 'plan', 'accept-edits', 'bypass', 'auto', 'strict'].map((value) => ({
				value,
				label: value,
			})),
		},
		confirm: 'Some modes act without asking.',
		confirmValues: ['accept-edits', 'bypass', 'auto'],
		default: 'prompt',
	}
	const profile = {
		path: 'browser.defaultProfile',
		label: 'Profile',
		description: 'x',
		section: 'tools' as const,
		control: { kind: 'text' as const },
		confirm: 'That profile holds sign-ins.',
		default: 'default',
	}
	const make = (saved: { path: string; set: boolean; value?: unknown }[] = []) => {
		const v: ConfigSettingsView = { file: '/x', descriptors: [modes, profile], settings: saved }
		const write = vi.fn(async () => v)
		return {
			write,
			settings: new ConfigSettings({ read: async () => v, write, validate: async () => {} }),
		}
	}
	it('does not ask when moving to a safer mode, and asks for each wider one', async () => {
		const { settings } = make()
		for (const safer of ['prompt', 'plan', 'strict'])
			expect(
				(await settings.change('w', { path: 'permissions.defaultMode', value: safer })).status,
			).toBe('saved')
		for (const wider of ['accept-edits', 'bypass', 'auto'])
			expect(
				(await settings.change('w', { path: 'permissions.defaultMode', value: wider })).status,
			).toBe('confirm')
	})
	it('does not ask to save the value a setting already holds', async () => {
		const { settings } = make([{ path: 'browser.defaultProfile', set: true, value: 'work' }])
		expect(
			(await settings.change('w', { path: 'browser.defaultProfile', value: 'work' })).status,
		).toBe('saved')
		expect(
			(await settings.change('w', { path: 'browser.defaultProfile', value: 'other' })).status,
		).toBe('confirm')
		// unset: the default is what it holds
		const fresh = make()
		expect(
			(await fresh.settings.change('w', { path: 'browser.defaultProfile', value: 'default' }))
				.status,
		).toBe('saved')
	})
})

describe('confirmation for the list controls', () => {
	const entries: ConfigSettingsView = {
		file: '/f',
		settings: [],
		descriptors: [
			{
				path: 'telemetry.sessionExport.redactors',
				label: 'Hide secrets',
				description: 'x',
				section: 'telemetry',
				control: { kind: 'toggle-list', on: ['secrets'], off: [] },
				default: ['secrets'],
				confirm: 'Secrets would be saved as they are.',
				confirmWhen: 'off',
			},
			{
				path: 'toolResultScreens',
				label: 'Screens',
				description: 'x',
				section: 'agent',
				control: {
					kind: 'screens',
					options: [
						{ value: 'correspondence', label: 'A' },
						{ value: 'injection', label: 'B' },
					],
					passthrough: { screen: 'correspondence', field: 'passthroughTools', label: 'Tools' },
				},
				default: ['correspondence'],
				confirm: 'Tool output would reach the model unchecked.',
				confirmWhen: 'drops-default',
			},
		],
	}
	const build = () => {
		const write = vi.fn(async () => entries)
		return {
			write,
			settings: new ConfigSettings({
				read: async () => entries,
				write,
				validate: async () => {},
			}),
		}
	}

	it('asks for the switch only when it goes off, and never for going back to the default', async () => {
		const { settings, write } = build()
		const path = 'telemetry.sessionExport.redactors'
		expect((await settings.change('w1', { path, value: [] })).status).toBe('confirm')
		expect((await settings.change('w1', { path, value: ['secrets'] })).status).toBe('saved')
		expect((await settings.change('w1', { path })).status).toBe('saved')
		expect(write).toHaveBeenCalledTimes(2)
	})

	it('asks for the screens only when the new list drops one the default holds', async () => {
		const { settings } = build()
		const path = 'toolResultScreens'
		expect((await settings.change('w1', { path, value: [] })).status).toBe('confirm')
		expect((await settings.change('w1', { path, value: ['injection'] })).status).toBe('confirm')
		expect(
			(await settings.change('w1', { path, value: ['correspondence', 'injection'] })).status,
		).toBe('saved')
		expect(
			(
				await settings.change('w1', {
					path,
					value: [{ name: 'correspondence', passthroughTools: ['x'] }],
				})
			).status,
		).toBe('saved')
		expect((await settings.change('w1', { path })).status).toBe('saved')
	})
})

describe('the extra folders ask only when one is added', () => {
	it('asks for a folder that is new, and writes nothing until confirmed', async () => {
		const { settings, write } = build()
		const added = await settings.change('w1', {
			path: 'additionalDirectories',
			value: ['/a', '/b', '/c'],
		})
		expect(added.status).toBe('confirm')
		expect(write).not.toHaveBeenCalled()
		if (added.status !== 'confirm') return
		expect(
			(
				await settings.change(
					'w1',
					{ path: 'additionalDirectories', value: ['/a', '/b', '/c'] },
					added.token,
				)
			).status,
		).toBe('saved')
	})

	it('saves a removal, a reorder and a clear at once', async () => {
		const { settings, write } = build()
		for (const value of [['/a'], ['/b', '/a'], undefined]) {
			const result = await settings.change('w1', {
				path: 'additionalDirectories',
				...(value ? { value } : {}),
			})
			expect(result.status).toBe('saved')
		}
		expect(write).toHaveBeenCalledTimes(3)
	})
})

describe('the auto mode reviewer asks only when it loosens or changes model', () => {
	const lists = [
		{ value: 'allow', label: 'Always allowed' },
		{ value: 'hardDeny', label: 'Always blocked' },
	]
	const reviewerView = (held: unknown): ConfigSettingsView => ({
		file: '/x/config.yaml',
		descriptors: [
			{
				path: 'permissions.autoMode',
				label: 'Auto mode reviewer',
				description: 'x',
				section: 'models',
				control: { kind: 'auto-mode', lists, example: '{}' },
				confirm: 'This decides which actions are approved without asking you.',
				confirmWhen: 'loosens',
			},
		],
		settings: held === undefined ? [] : [{ path: 'permissions.autoMode', set: true, value: held }],
	})
	const run = async (held: unknown, value: unknown) => {
		const write = vi.fn(async () => reviewerView(held))
		const settings = new ConfigSettings({
			read: async () => reviewerView(held),
			write,
			validate: async () => {},
		})
		const result = await settings.change('w1', { path: 'permissions.autoMode', value })
		return { result, write }
	}

	it('asks with the entry named when an allow list gains one', async () => {
		const { result, write } = await run(undefined, { allow: ['$defaults', 'Run the tests'] })
		expect(result.status).toBe('confirm')
		if (result.status === 'confirm')
			expect(result.message).toContain('Added to "Always allowed": Run the tests.')
		expect(write).not.toHaveBeenCalled()
	})

	it('asks when a block list loses an entry, and when the model changes', async () => {
		const held = { hardDeny: ['$defaults', 'Drop the database'] }
		const removed = await run(held, { hardDeny: ['$defaults'] })
		expect(removed.result.status).toBe('confirm')
		if (removed.result.status === 'confirm')
			expect(removed.result.message).toContain('Removed from "Always blocked": Drop the database.')
		const model = await run(held, { ...held, model: 'smallModel' })
		expect(model.result.status).toBe('confirm')
		if (model.result.status === 'confirm')
			expect(model.result.message).toContain('Reviewer model: smallModel.')
	})

	it('saves a change that only restricts at once, and keeping the same table asks nothing', async () => {
		const held = { hardDeny: ['$defaults'], allow: ['A'] }
		const tighter = await run(held, { hardDeny: ['$defaults', 'B'], allow: [] })
		expect(tighter.result.status).toBe('saved')
		expect(tighter.write).toHaveBeenCalledTimes(1)
		const same = await run(held, held)
		expect(same.result.status).toBe('saved')
	})

	it('asks when Use default would bring a removed block list back looser', async () => {
		const settings = new ConfigSettings({
			read: async () => reviewerView({ allow: [] }),
			write: async () => reviewerView(undefined),
			validate: async () => {},
		})
		const result = await settings.change('w1', { path: 'permissions.autoMode' })
		expect(result.status).toBe('confirm')
	})
})
