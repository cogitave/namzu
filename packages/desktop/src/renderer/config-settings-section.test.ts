import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ConfigSettingsView } from '../shared/config-settings-protocol.js'
import {
	configSearchEntries,
	configSettingId,
	confirmationCopy,
	defaultToggle,
	numberFromText,
} from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import { searchSettings } from './settings-model.js'
import type { ConfigSettingsControls } from './use-config-settings.js'

const view: ConfigSettingsView = {
	file: '/x/config.yaml',
	descriptors: [
		{
			path: 'limits.doneGate',
			label: 'Check before finishing',
			description: 'Check once.',
			section: 'agent',
			control: { kind: 'toggle' },
			defaultText: 'on',
		},
		{
			path: 'limits.maxIterations',
			label: 'Most steps per task',
			description: '0 means no limit.',
			section: 'agent',
			control: { kind: 'number', min: 0 },
			defaultText: 'no limit',
		},
		{
			path: 'format',
			label: 'Output format',
			description: 'How results print.',
			section: 'agent',
			control: {
				kind: 'select',
				options: [
					{ value: 'text', label: 'text' },
					{ value: 'json', label: 'json' },
				],
			},
		},
		{
			path: 'permissions',
			label: 'Permission rules',
			description: 'Allow or deny.',
			section: 'agent',
			control: { kind: 'json', example: '{}' },
		},
		{
			path: 'mcpServers',
			label: 'Connected servers',
			description: 'Edit in the file.',
			section: 'agent',
			control: { kind: 'file-only' },
		},
		{
			path: 'tui.mouse',
			label: 'Mouse',
			description: 'full or off',
			section: 'terminal',
			control: { kind: 'select', options: [{ value: 'full', label: 'full' }] },
		},
	],
	settings: [
		{ path: 'limits.maxIterations', set: true, value: 7 },
		{ path: 'mcpServers', set: true },
	],
}

const controls = (over: Partial<ConfigSettingsControls> = {}): ConfigSettingsControls => ({
	view,
	loadError: '',
	errors: {},
	change: vi.fn(async () => true),
	confirmation: undefined,
	confirm: vi.fn(),
	dismiss: vi.fn(),
	...over,
})
const html = (section: 'agent' | 'terminal', config = controls()) =>
	renderToStaticMarkup(createElement(ConfigSettingsGroup, { section, config }))

describe('engine settings in the page', () => {
	it('draws each control the engine describes, with a one-line description', () => {
		const out = html('agent')
		expect(out).toContain('role="switch"')
		expect(out).toContain('type="number"')
		expect(out).toContain('value="7"')
		expect(out).toContain('<select')
		expect(out).toContain('<textarea')
		expect(out).toContain('Check once.')
		expect(out).toContain('Default: on.')
		expect(out).not.toContain('Mouse')
	})

	it('shows a file-only setting as set or not, never its value', () => {
		const out = html('agent')
		expect(out).toContain('Set in your config file')
		expect(out).not.toContain('<textarea aria-label="Connected servers"')
	})

	it('offers to go back to the default only for a saved value', () => {
		const out = html('agent')
		expect(out.match(/Use the default for/g)?.length).toBe(1)
		expect(out).toContain('Use the default for Most steps per task')
	})

	it('shows the engine error under the field that caused it', () => {
		const out = html(
			'agent',
			controls({ errors: { 'limits.maxIterations': 'must be a whole number' } }),
		)
		expect(out).toContain('role="alert"')
		expect(out).toContain('must be a whole number')
	})

	it('words the confirmation from the engine sentence', () => {
		expect(confirmationCopy('Mouse changes.')).toEqual({
			title: 'Change this setting?',
			description: 'Mouse changes.',
			confirm: 'Change it',
			cancel: 'Cancel',
		})
	})

	it('draws nothing before the engine answers', () => {
		expect(html('agent', controls({ view: undefined }))).toBe('')
	})

	it('is found by search', () => {
		const found = searchSettings('steps', configSearchEntries(view))
		expect(found.map((e) => e.id)).toEqual([configSettingId('limits.maxIterations')])
	})
})

describe('helpers', () => {
	it('reads the default of a switch from its words', () => {
		expect(defaultToggle(view.descriptors[0]!)).toBe(true)
		expect(defaultToggle(view.descriptors[1]!)).toBe(false)
	})
	it('checks a number before it is sent', () => {
		expect(numberFromText('', {})).toEqual({ error: 'Enter a number.' })
		expect(numberFromText('x', {})).toEqual({ error: 'Enter a number.' })
		expect(numberFromText('1', { min: 2 })).toEqual({ error: 'Enter 2 or more.' })
		expect(numberFromText('17', { max: 16 })).toEqual({ error: 'Enter 16 or less.' })
		expect(numberFromText(' 8 ', { min: 2, max: 16 })).toEqual({ value: 8 })
	})
})
