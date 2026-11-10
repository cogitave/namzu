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
			path: 'permissions',
			label: 'Rules',
			description: 'x',
			section: 'projects',
			control: { kind: 'json', example: '{}' },
			confirm: 'Rules can let tools run.',
		},
	],
	settings: [],
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
