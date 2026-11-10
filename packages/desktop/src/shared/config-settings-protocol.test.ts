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
