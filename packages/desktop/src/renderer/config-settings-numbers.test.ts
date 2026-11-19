import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
	type ConfigSettingDescriptor,
	type ConfigSettingsView,
	readConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import {
	formatDuration,
	numberFromText,
	numberPlaceholder,
	parseDuration,
	parseTokens,
	rangeText,
	requirementNote,
} from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import { updateStatusView } from './settings-model.js'
import type { ConfigSettingsControls } from './use-config-settings.js'

describe('times written as minutes and seconds', () => {
	it('reads 5m, 90s, 1h 30m, 250ms, and a bare number as minutes', () => {
		expect(parseDuration('5m')).toBe(300_000)
		expect(parseDuration('90s')).toBe(90_000)
		expect(parseDuration('1h 30m')).toBe(5_400_000)
		expect(parseDuration('1m30s')).toBe(90_000)
		expect(parseDuration('250ms')).toBe(250)
		expect(parseDuration('2')).toBe(120_000)
		expect(parseDuration('0')).toBe(0)
		expect(parseDuration('soon')).toBeUndefined()
		expect(parseDuration('')).toBeUndefined()
	})
	it('shows milliseconds back the same way', () => {
		expect(formatDuration(300_000)).toBe('5m')
		expect(formatDuration(90_000)).toBe('1m 30s')
		expect(formatDuration(600_000)).toBe('10m')
		expect(formatDuration(30_000)).toBe('30s')
		expect(formatDuration(250)).toBe('250ms')
		expect(formatDuration(0)).toBe('0')
	})
	it('stores milliseconds and enforces the engine range', () => {
		const control = { min: 0, max: 2_147_483_647, unit: 'ms' }
		expect(numberFromText('1m', control)).toEqual({ value: 60_000 })
		expect(numberFromText('9999h', control)).toMatchObject({
			error: expect.stringContaining('or less'),
		})
		expect(numberFromText('nope', control)).toEqual({
			error: 'Enter minutes and seconds, such as 5m or 90s.',
		})
		expect(numberFromText('0', { min: 1, unit: 'ms' })).toEqual({ error: 'Enter 1ms or more.' })
	})
})

describe('token sizes', () => {
	it('reads 786k, 1m and plain numbers', () => {
		expect(parseTokens('786k')).toBe(786_000)
		expect(parseTokens('1m')).toBe(1_000_000)
		expect(parseTokens('1.5m')).toBe(1_500_000)
		expect(parseTokens('200,000')).toBe(200_000)
		expect(parseTokens('lots')).toBeUndefined()
	})
	it('checks them against the range and names it in short form', () => {
		const control = { min: 100_000, max: 1_000_000, unit: 'tokens' }
		expect(numberFromText('786k', control)).toEqual({ value: 786_000 })
		expect(numberFromText('2m', control)).toEqual({ error: 'Enter 1m or less.' })
		expect(numberFromText('50k', control)).toEqual({ error: 'Enter 100k or more.' })
		expect(rangeText(control)).toBe('From 100k to 1m.')
	})
})

describe('the range sentence and the placeholder', () => {
	it('says nothing for an open range from 0, and names every other bound', () => {
		expect(rangeText({ min: 0 })).toBe('')
		expect(rangeText({ min: 1, max: 16 })).toBe('From 1 to 16.')
		expect(rangeText({ min: 1 })).toBe('At least 1.')
		expect(rangeText({ max: 20 })).toBe('Up to 20.')
		expect(rangeText({ min: 1, max: 2_147_483_647, unit: 'ms' })).toBe('')
	})
	it('keeps the placeholder inside a 140 px box', () => {
		const d = (over: Partial<ConfigSettingDescriptor>): ConfigSettingDescriptor => ({
			path: 'a.b',
			label: 'A',
			description: 'd',
			section: 'agent',
			control: { kind: 'number' },
			...over,
		})
		expect(numberPlaceholder(d({ default: 8 }))).toBe('8')
		expect(numberPlaceholder(d({ default: 30_000, control: { kind: 'number', unit: 'ms' } }))).toBe(
			'30s',
		)
		expect(numberPlaceholder(d({ defaultText: 'no limit' }))).toBe('no limit')
		expect(numberPlaceholder(d({ defaultText: '24000 at medium effort and above' }))).toBe(
			'default',
		)
	})
})

const raw = (descriptors: unknown[], settings: unknown[] = []): ConfigSettingsView =>
	readConfigSettingsView({ file: '/home/x/.namzu/config.yaml', descriptors, settings })

describe('a setting that needs another', () => {
	const idle = {
		path: 'compaction.idleCompaction',
		label: 'Shorten while idle',
		description: 'd',
		section: 'agent',
		control: { kind: 'toggle' },
		requires: { path: 'compaction.promptCacheTtl', is: '1h', note: 'Needs the 1 hour cache.' },
	}
	const ttl = {
		path: 'compaction.promptCacheTtl',
		label: 'Cache lifetime',
		description: 'd',
		section: 'agent',
		control: {
			kind: 'select',
			options: [
				{ value: '5m', label: '5 minutes' },
				{ value: '1h', label: '1 hour' },
			],
		},
		default: '5m',
	}
	it('warns at the 5 minute default and when saved as 5m, and stops warning at 1h', () => {
		const at5 = raw([idle, ttl])
		const d = at5.descriptors[0] as ConfigSettingDescriptor
		expect(requirementNote(d, at5)).toBe('Needs the 1 hour cache.')
		const saved1h = raw(
			[idle, ttl],
			[{ path: 'compaction.promptCacheTtl', set: true, value: '1h' }],
		)
		expect(requirementNote(saved1h.descriptors[0] as ConfigSettingDescriptor, saved1h)).toBe('')
	})
})

const controls = (view: ConfigSettingsView): ConfigSettingsControls => ({
	view,
	loadError: '',
	loading: false,
	reload: () => {},
	resets: {},
	discard: () => {},
	errors: {},
	change: async () => true,
	confirmation: undefined,
	confirm: async () => {},
	dismiss: () => {},
})
const draw = (view: ConfigSettingsView, section: 'agent' | 'general') =>
	renderToStaticMarkup(createElement(ConfigSettingsGroup, { section, config: controls(view) }))

describe('rows drawn from the engine', () => {
	it('names the config file under a file-only row, set or not', () => {
		const view = raw([
			{
				path: 'profiles',
				label: 'Profiles',
				description: 'Named bundles.',
				section: 'general',
				control: { kind: 'file-only' },
			},
		])
		const html = draw(view, 'general')
		expect(html).toContain('Not set')
		expect(html).toContain('Config file: /home/x/.namzu/config.yaml.')
	})
	it('shows the range and a placeholder that fits, and a time as minutes', () => {
		const view = raw(
			[
				{
					path: 'workflow.maxConcurrency',
					label: 'Helpers working at once',
					description: 'How many.',
					section: 'agent',
					control: { kind: 'number', min: 1, max: 16 },
					defaultText: 'processors minus 2, at most 16',
				},
				{
					path: 'limits.timeoutMs',
					label: 'Longest turn time',
					description: 'How long.',
					section: 'agent',
					control: { kind: 'number', min: 0, max: 2147483647, unit: 'ms' },
				},
			],
			[{ path: 'limits.timeoutMs', set: true, value: 300000 }],
		)
		const html = draw(view, 'agent')
		expect(html).toContain('From 1 to 16.')
		expect(html).toContain('placeholder="default"')
		expect(html).toContain('value="5m"')
		expect(html).not.toContain('>ms<')
	})
})

describe('the update status before and after a check', () => {
	it('says it has not checked yet, until a check has happened', () => {
		expect(updateStatusView({ status: 'idle' }, false).text).toBe('Not checked yet.')
		expect(updateStatusView({ status: 'idle' }, true).text).toBe('Up to date.')
		expect(updateStatusView({ status: 'idle' }, false)).toMatchObject({
			action: 'check',
			canCheck: true,
		})
	})
})
