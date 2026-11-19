import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
	type ConfigSettingDescriptor,
	type ConfigSettingsView,
	readConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import {
	appliesLine,
	defaultHelper,
	defaultLabel,
	defaultToggle,
	effectiveDefault,
} from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import type { ConfigSettingsControls } from './use-config-settings.js'

const toggle = (over: Partial<ConfigSettingDescriptor>): ConfigSettingDescriptor => ({
	path: 'x.y',
	label: 'Thing',
	description: 'Does a thing.',
	section: 'agent',
	control: { kind: 'toggle' },
	...over,
})

const viewOf = (
	descriptors: ConfigSettingDescriptor[],
	settings: ConfigSettingsView['settings'] = [],
): ConfigSettingsView => ({ file: '/f', descriptors, settings })

const controls = (view: ConfigSettingsView): ConfigSettingsControls =>
	({
		view,
		loadError: undefined,
		loading: false,
		resets: {},
		discard: () => undefined,
		reload: () => undefined,
		confirmation: undefined,
		errors: {},
		change: async () => true,
		confirm: () => undefined,
		dismiss: () => undefined,
	}) as unknown as ConfigSettingsControls

const page = (view: ConfigSettingsView) =>
	renderToStaticMarkup(
		createElement(ConfigSettingsGroup, { section: 'agent', config: controls(view) }),
	)

describe('a default is read from its typed value', () => {
	it('shows an unset switch as on when the typed default is on, whatever the words say', () => {
		const d = toggle({ default: true, defaultText: 'off' })
		expect(defaultToggle(d)).toBe(true)
		expect(defaultToggle(toggle({ default: false, defaultText: 'on' }))).toBe(false)
		expect(defaultLabel(d)).toBe('On')
	})

	it('falls back to the words only for an engine that sends no typed default', () => {
		expect(defaultToggle(toggle({ defaultText: 'on' }))).toBe(true)
		expect(defaultToggle(toggle({}))).toBe(false)
	})

	it('shows the ticked options of a list default, in plain labels', () => {
		const d: ConfigSettingDescriptor = {
			...toggle({}),
			control: {
				kind: 'checks',
				options: [
					{ value: 'en', label: 'English' },
					{ value: 'tr', label: 'Turkish' },
				],
			},
			default: ['en', 'tr'],
		}
		expect(defaultLabel(d)).toBe('English, Turkish')
		const out = page(viewOf([d]))
		expect(out.match(/checked=""/g)?.length).toBe(2)
	})

	it('follows the rule that changes a default when another key is set', () => {
		const d = toggle({
			path: 'sandbox.enabled',
			default: false,
			defaultNote: 'On when isolation is required.',
			defaultWhen: [{ path: 'sandbox.requireIsolation', is: 'non-empty', value: true }],
		})
		expect(effectiveDefault(d, viewOf([d]))).toBe(false)
		const set = viewOf([d], [{ path: 'sandbox.requireIsolation', set: true, value: ['network'] }])
		expect(effectiveDefault(d, set)).toBe(true)
		expect(defaultToggle(d, set)).toBe(true)
		const empty = viewOf([d], [{ path: 'sandbox.requireIsolation', set: true, value: [] }])
		expect(effectiveDefault(d, empty)).toBe(false)
		expect(
			effectiveDefault(
				{ ...d, defaultWhen: [{ path: 'sandbox.workspace', is: 'ephemeral', value: true }] },
				viewOf([d], [{ path: 'sandbox.workspace', set: true, value: 'ephemeral' }]),
			),
		).toBe(true)
	})

	it('puts a number default with its unit, and a select default as its label', () => {
		const n: ConfigSettingDescriptor = {
			...toggle({}),
			control: { kind: 'number', unit: 'ms' },
			default: 600000,
		}
		expect(defaultLabel(n)).toBe('10m')
		const sel: ConfigSettingDescriptor = {
			...toggle({}),
			control: { kind: 'select', options: [{ value: 'a', label: 'Alpha', help: 'The first.' }] },
			default: 'a',
		}
		expect(defaultHelper(sel)).toBe('')
	})

	it('keeps a sentence default under a number row, where the placeholder cannot hold it', () => {
		const sentence: ConfigSettingDescriptor = {
			...toggle({}),
			control: { kind: 'number', unit: 'ms' },
			default: { dynamic: true } as never,
			defaultText: 'a one-shot run does not wait; a scheduled run waits 10 minutes',
		}
		expect(defaultHelper(sentence)).toBe(
			'Default · a one-shot run does not wait; a scheduled run waits 10 minutes',
		)
		const typed: ConfigSettingDescriptor = { ...sentence, default: 600000, defaultText: undefined }
		expect(defaultHelper(typed)).toBe('')
		const short: ConfigSettingDescriptor = { ...sentence, defaultText: 'unlimited' }
		expect(defaultHelper(short)).toBe('')
	})

	it('says no default under a text box with its own placeholder or under a list that is empty by default', () => {
		const text: ConfigSettingDescriptor = {
			...toggle({}),
			control: { kind: 'text', placeholder: 'Inside the project' },
			default: undefined,
			defaultText: "inside the project's own folder",
		}
		expect(defaultHelper(text)).toBe('')
		const list: ConfigSettingDescriptor = {
			...toggle({}),
			control: { kind: 'list', itemLabel: 'folder' },
			default: [],
		}
		expect(defaultHelper(list)).toBe('')
	})
})

describe('a row says its default, its choice help and when a change applies', () => {
	const select: ConfigSettingDescriptor = {
		...toggle({ path: 'a.b', label: 'Pick one' }),
		control: {
			kind: 'select',
			options: [
				{ value: 'x', label: 'Plain X', help: 'Does the X thing.' },
				{ value: 'y', label: 'Plain Y', help: 'Does the Y thing.' },
			],
		},
		default: 'x',
		appliesWhen: 'next-conversation',
	}

	it('draws options as words and keeps the saved value in the value attribute', () => {
		const out = page(viewOf([select]))
		expect(out).toContain('value="y"')
		expect(out).toContain('>Plain Y<')
		expect(out).toContain('Default · Plain X')
	})

	it('adds the help of the chosen option, and no default or apply line the page says elsewhere', () => {
		const out = page(viewOf([select]))
		expect(out).toContain('Does the X thing.')
		// The default is marked inside the list, and a row that applies to new conversations carries
		// no sentence: the section note says it once.
		expect(out).not.toContain('Default: Plain X.')
		expect(out).not.toContain('Applies to new conversations')
		expect(out).not.toContain('settings-row-badge')
		const chosen = page(viewOf([select], [{ path: 'a.b', set: true, value: 'y' }]))
		expect(chosen).toContain('Does the Y thing.')
	})

	it('draws an unset default-on switch as on', () => {
		const out = page(viewOf([toggle({ default: true, appliesWhen: 'next-start' })]))
		expect(out).toContain('aria-checked="true"')
		// A row that waits for a restart says so in a badge; the whole sentence is its name and tooltip.
		expect(out).toContain('>After restart</span>')
		expect(out).toContain('title="Applies the next time Namzu starts."')
		expect(out).toContain('aria-label="Applies the next time Namzu starts."')
	})

	it('says nothing about timing for an engine that does not say', () => {
		expect(appliesLine(toggle({}))).toBe('')
	})
})

describe('the wire reader keeps the new fields and the old ones', () => {
	it('reads typed default, rules, apply time, option help and layer', () => {
		const read = readConfigSettingsView({
			file: '/f',
			descriptors: [
				{
					path: 'a',
					label: 'A',
					description: 'd',
					section: 'agent',
					control: { kind: 'select', options: [{ value: 'x', label: 'X', help: 'h' }] },
					default: 'x',
					defaultNote: 'n',
					defaultWhen: [{ path: 'b', is: 'non-empty', value: true }, { bad: 1 }],
					appliesWhen: 'next-start',
				},
				{
					path: 'c',
					label: 'C',
					description: 'd',
					section: 'agent',
					control: { kind: 'toggle' },
					default: { not: 'a value' },
					appliesWhen: 'sometime',
					defaultText: 'on',
				},
			],
			settings: [
				{ path: 'a', set: true, value: 'x', layer: 'project' },
				{ path: 'c', set: false, layer: 'nowhere' },
			],
		})
		const [a, c] = read.descriptors
		expect(a?.default).toBe('x')
		expect(a?.defaultNote).toBe('n')
		expect(a?.defaultWhen).toEqual([{ path: 'b', is: 'non-empty', value: true }])
		expect(a?.appliesWhen).toBe('next-start')
		expect(a?.control).toEqual({ kind: 'select', options: [{ value: 'x', label: 'X', help: 'h' }] })
		expect(c?.default).toBeUndefined()
		expect(c?.appliesWhen).toBeUndefined()
		expect(c?.defaultText).toBe('on')
		expect(read.settings[0]?.layer).toBe('project')
		expect(read.settings[1]?.layer).toBeUndefined()
	})
})
