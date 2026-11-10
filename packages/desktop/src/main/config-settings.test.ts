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
		},
	],
	settings: [],
}

function build() {
	const write = vi.fn(async () => view)
	return { write, settings: new ConfigSettings({ read: async () => view, write }) }
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
			settings.change('w1', { path: 'sandbox.enabled', value: true }, first.token),
		).rejects.toThrow(/expired/)
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
		const settings = new ConfigSettings({ read: async () => view, write })
		await expect(settings.change('w1', { path: 'quiet', value: 9 })).rejects.toThrow(
			/between 2 and 16/,
		)
	})
})
