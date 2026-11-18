import { describe, expect, it } from 'vitest'
import { readConfigSettingChange, readConfigSettingsView } from './config-settings-protocol.js'

const descriptor = {
	path: 'limits.maxIterations',
	label: 'Most steps per task',
	description: '0 means no limit.',
	section: 'agent',
	control: { kind: 'number', min: 0 },
}

describe('reading the engine description', () => {
	it('keeps what Desktop can draw and drops the rest', () => {
		const view = readConfigSettingsView({
			file: '/x/config.yaml',
			descriptors: [
				descriptor,
				{ ...descriptor, path: 'a', control: { kind: 'sparkle' } },
				{ ...descriptor, path: 'b', section: 'elsewhere' },
				{
					...descriptor,
					path: 'c',
					control: { kind: 'select', options: [{ value: 'x', label: 'x' }] },
				},
			],
			settings: [{ path: 'limits.maxIterations', set: true, value: 4 }, { path: 5 }],
		})
		expect(view.descriptors.map((d) => d.path)).toEqual(['limits.maxIterations', 'c'])
		expect(view.settings).toEqual([{ path: 'limits.maxIterations', set: true, value: 4 }])
	})

	it('refuses an answer with no list', () => {
		expect(() => readConfigSettingsView({})).toThrow(/could not be read/)
		expect(() => readConfigSettingsView(null)).toThrow()
	})

	it('never carries a value for a setting that is not set', () => {
		const view = readConfigSettingsView({
			descriptors: [],
			settings: [{ path: 'quiet', set: false, value: true }],
		})
		expect(view.settings).toEqual([{ path: 'quiet', set: false }])
	})
})

describe('reading a change', () => {
	it('accepts a path and an optional value', () => {
		expect(readConfigSettingChange({ path: 'quiet', value: true })).toEqual({
			path: 'quiet',
			value: true,
		})
		expect(readConfigSettingChange({ path: 'quiet' })).toEqual({ path: 'quiet' })
		expect(readConfigSettingChange({ path: 'quiet', value: null })).toEqual({ path: 'quiet' })
	})
	it('rejects anything else', () => {
		expect(() => readConfigSettingChange({ path: '' })).toThrow()
		expect(() => readConfigSettingChange({ path: 'quiet', file: '/etc/passwd' })).toThrow()
		expect(() => readConfigSettingChange('quiet')).toThrow()
	})
})

describe('the list and map controls', () => {
	const view = (control: unknown, extra: Record<string, unknown> = {}) =>
		readConfigSettingsView({
			file: '/f',
			settings: [],
			descriptors: [
				{ path: 'k', label: 'K', description: 'd', section: 'terminal', control, ...extra },
			],
		}).descriptors[0]

	it('reads every new kind with the fields it needs', () => {
		const options = [{ value: 'a', label: 'A', help: 'h' }]
		expect(view({ kind: 'toggle-checks', options, whenOn: ['a'] })?.control).toEqual({
			kind: 'toggle-checks',
			options,
			whenOn: ['a'],
		})
		expect(view({ kind: 'toggle-list', on: ['secrets'], off: [] })?.control.kind).toBe(
			'toggle-list',
		)
		expect(view({ kind: 'key', options })?.control.kind).toBe('key')
		expect(view({ kind: 'levels', entries: options, levels: options })?.control.kind).toBe('levels')
		expect(
			view({
				kind: 'screens',
				options,
				passthrough: { screen: 'a', field: 'f', label: 'L' },
			})?.control.kind,
		).toBe('screens')
		expect(view({ kind: 'list', itemLabel: 'folder', picker: 'folder' })?.control).toEqual({
			kind: 'list',
			itemLabel: 'folder',
			picker: 'folder',
		})
		expect(view({ kind: 'list', itemLabel: 'skill name', source: 'skills' })?.control).toEqual({
			kind: 'list',
			itemLabel: 'skill name',
			source: 'skills',
		})
		expect(view({ kind: 'list', itemLabel: 'x', source: 'other' })?.control).toEqual({
			kind: 'list',
			itemLabel: 'x',
		})
		expect(
			view({ kind: 'list', itemLabel: 'folder' }, { confirmWhen: 'widens' })?.confirmWhen,
		).toBe('widens')
		expect(view({ kind: 'checks', options, allLabel: 'All', emptyNote: 'None.' })?.control).toEqual(
			{
				kind: 'checks',
				options,
				allLabel: 'All',
				emptyNote: 'None.',
			},
		)
	})

	it('drops a control that lacks what it needs, and reads a map default and a new confirm rule', () => {
		expect(view({ kind: 'levels', entries: [] })).toBeUndefined()
		expect(view({ kind: 'toggle-list', on: ['x'] })).toBeUndefined()
		const levels = {
			kind: 'levels',
			entries: [{ value: 'a', label: 'A' }],
			levels: [{ value: 'arm', label: 'Arm' }],
		}
		const row = view(levels, { default: { a: 'arm' }, confirmWhen: 'drops-default' })
		expect(row?.default).toEqual({ a: 'arm' })
		expect(row?.confirmWhen).toBe('drops-default')
		// A map is a default only for a control that holds one.
		expect(view({ kind: 'toggle' }, { default: { a: 'arm' } })?.default).toBeUndefined()
	})
})

describe('reading the model rows', () => {
	const row = (control: unknown, extra: Record<string, unknown> = {}) =>
		readConfigSettingsView({
			descriptors: [{ ...descriptor, path: 'm', section: 'models', control, ...extra }],
			settings: [],
		}).descriptors[0]

	it('reads the model, routing and reviewer controls', () => {
		expect(row({ kind: 'model', placeholder: 'provider/model' })?.control).toEqual({
			kind: 'model',
			placeholder: 'provider/model',
		})
		expect(row({ kind: 'routing', example: '{}' })?.control).toEqual({
			kind: 'routing',
			example: '{}',
		})
		const lists = [{ value: 'allow', label: 'Always allowed', help: 'x' }]
		expect(
			row({ kind: 'auto-mode', lists, example: '{}' }, { confirmWhen: 'loosens' }),
		).toMatchObject({
			control: { kind: 'auto-mode', lists },
			confirmWhen: 'loosens',
		})
	})

	it('drops a reviewer or routing row that lacks what Desktop needs to draw it', () => {
		expect(row({ kind: 'routing' })).toBeUndefined()
		expect(row({ kind: 'auto-mode', example: '{}' })).toBeUndefined()
		expect(row({ kind: 'auto-mode', lists: [{ value: 1 }], example: '{}' })).toBeUndefined()
	})

	it('keeps the variable that replaces a saved value, and nothing malformed', () => {
		const view = readConfigSettingsView({
			descriptors: [],
			settings: [
				{ path: 'smallModel', set: false, env: { variable: 'NAMZU_SMALL_MODEL', value: 'a/b' } },
				{ path: 'x', set: false, env: { variable: 'NAMZU_X' } },
			],
		})
		expect(view.settings).toEqual([
			{ path: 'smallModel', set: false, env: { variable: 'NAMZU_SMALL_MODEL', value: 'a/b' } },
			{ path: 'x', set: false },
		])
	})
})
