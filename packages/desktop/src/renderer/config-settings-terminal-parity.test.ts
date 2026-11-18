import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as values from '../shared/config-settings-values.js'
import type * as Model from './config-settings-model.js'
import {
	displayNumber,
	formatDuration,
	numberFromText,
	parseDuration,
	parseTokens,
	rangeText,
} from './config-settings-model.js'

/**
 * `namzu config set` and `/config <key> <value>` read numbers through the CLI's own copy of these
 * functions (`cli/src/config/setting-values.ts`), because Desktop and the CLI cannot import one
 * another. This feeds one table of inputs to both and fails when they stop agreeing, so a value
 * Desktop refuses is refused in the terminal with the same sentence.
 */
const CLI = fileURLToPath(new URL('../../../cli/src/config/setting-values.ts', import.meta.url))

const CONTROLS = [
	{ min: 0, max: 2_147_483_647, unit: 'ms' },
	{ min: 1, unit: 'ms' },
	{ min: 100_000, max: 1_000_000, unit: 'tokens' },
	{ min: 1, max: 16 },
	{ min: 0 },
	{ max: 20 },
	{},
]
const INPUTS = [
	'5m',
	'90s',
	'1h 30m',
	'1m30s',
	'250ms',
	'2',
	'0',
	'',
	' 12 ',
	'786k',
	'1m',
	'1.5m',
	'200,000',
	'2m',
	'50k',
	'9999h',
	'17',
	'-1',
	'banana',
	'soon',
	'1e3',
	'NaN',
]

describe('Desktop and the terminal read numbers alike', () => {
	it('answer every input the same way for every kind of control', async () => {
		const cli = (await import(/* @vite-ignore */ CLI)) as Pick<
			typeof Model,
			| 'numberFromText'
			| 'rangeText'
			| 'parseDuration'
			| 'parseTokens'
			| 'formatDuration'
			| 'displayNumber'
		>
		for (const control of CONTROLS)
			for (const input of INPUTS) {
				expect(cli.numberFromText(input, control), `${JSON.stringify(control)} ${input}`).toEqual(
					numberFromText(input, control),
				)
				expect(cli.rangeText(control)).toBe(rangeText(control))
			}
		for (const input of INPUTS) {
			expect(cli.parseDuration(input), input).toBe(parseDuration(input))
			expect(cli.parseTokens(input), input).toBe(parseTokens(input))
		}
		for (const ms of [0, 250, 30_000, 90_000, 300_000, 5_400_000]) {
			expect(cli.formatDuration(ms)).toBe(formatDuration(ms))
			expect(cli.displayNumber(ms, 'ms')).toBe(displayNumber(ms, 'ms'))
		}
	})
})

describe('Desktop and the terminal read the list and map controls alike', () => {
	const events = {
		options: [
			{ value: 'turn-settled', label: 'Turn finished' },
			{ value: 'approval-required', label: 'Approval needed' },
			{ value: 'idle-prompt', label: 'Waiting for you' },
		],
		whenOn: ['turn-settled', 'approval-required'],
	}
	const triggers = { hypermode: 'arm', workflow: 'arm', schedule: 'suggest', 'max-effort': 'off' }
	const screens = {
		options: [
			{ value: 'correspondence', label: 'Repeats the request' },
			{ value: 'injection', label: 'Hidden instructions' },
		],
		passthrough: { screen: 'correspondence', field: 'passthroughTools', label: 'Tools' },
	}
	const withTools = { name: 'correspondence', passthroughTools: ['a', 'b'] }

	it('answer every input the same way', async () => {
		const cli = (await import(/* @vite-ignore */ CLI)) as typeof values
		for (const ticked of [
			[],
			['turn-settled'],
			['approval-required', 'turn-settled'],
			['idle-prompt', 'turn-settled'],
			['turn-settled', 'approval-required', 'idle-prompt'],
		])
			expect(cli.eventSwitchValue(ticked, events), ticked.join()).toEqual(
				values.eventSwitchValue(ticked, events),
			)
		for (const saved of [true, false, undefined, [], ['idle-prompt'], 'x'])
			expect(cli.eventSwitchTicked(saved, events)).toEqual(values.eventSwitchTicked(saved, events))
		for (const chosen of [
			{} as Record<string, string>,
			{ hypermode: 'suggest' },
			{ hypermode: 'arm', workflow: 'arm' },
			{ schedule: 'suggest', 'max-effort': 'arm' },
		]) {
			expect(cli.levelsValue(chosen, triggers)).toEqual(values.levelsValue(chosen, triggers))
			expect(cli.levelsHeld(chosen, triggers)).toEqual(values.levelsHeld(chosen, triggers))
		}
		for (const [ticked, tools] of [
			[['correspondence'], []],
			[['correspondence', 'injection'], []],
			[['correspondence'], [' a ', 'a', 'b', '']],
			[['injection'], ['a']],
			[[], []],
		] as const)
			expect(cli.screensValue(ticked, tools, screens, ['correspondence']), ticked.join()).toEqual(
				values.screensValue(ticked, tools, screens, ['correspondence']),
			)
		for (const value of [
			['correspondence', { name: 'injection' }, withTools],
			[withTools],
			[],
			undefined,
			'x',
		]) {
			expect(cli.screenNames(value)).toEqual(values.screenNames(value))
			expect(cli.screenTools(value, 'correspondence', 'passthroughTools')).toEqual(
				values.screenTools(value, 'correspondence', 'passthroughTools'),
			)
		}
		for (const [a, b] of [
			[
				['a', 'b'],
				['b', 'a'],
			],
			[['a'], ['a', 'b']],
			[[], []],
			['a', ['a']],
		])
			expect(cli.sameSet(a, b)).toBe(values.sameSet(a, b))
		for (const [current, value] of [
			[['/a'], ['/a', '/b']],
			[['/a', '/b'], ['/a']],
			[
				['/a', '/b'],
				['/b', '/a'],
			],
			[undefined, ['/a']],
			[undefined, []],
			[[], 'x'],
		] as const)
			expect(cli.widensList(current, value), JSON.stringify([current, value])).toBe(
				values.widensList(current, value),
			)
		for (const [defaults, value] of [
			[['correspondence'], []],
			[['correspondence'], ['correspondence', 'injection']],
			[['correspondence'], [withTools]],
			[['correspondence'], ['injection']],
		] as const)
			expect(cli.droppedFromDefault(defaults, value)).toBe(
				values.droppedFromDefault(defaults, value),
			)
	})

	it('word every saved value the same way', async () => {
		const cli = (await import(/* @vite-ignore */ CLI)) as typeof values
		const all = events.options.map((o) => o.value)
		const controls = [
			[{ kind: 'toggle-checks', ...events }, [true, false, ['idle-prompt'], []]],
			[{ kind: 'toggle-list', on: ['secrets'], off: [] }, [['secrets'], [], ['x']]],
			[{ kind: 'key', options: [{ value: 'ctrl+b', label: 'Ctrl+B' }] }, ['ctrl+b', 'x']],
			[
				{
					kind: 'levels',
					entries: [{ value: 'hypermode', label: 'Hypermode' }],
					levels: [{ value: 'arm', label: 'Arm' }],
				},
				[{ hypermode: 'arm' }, {}],
			],
			[{ kind: 'screens', ...screens }, [['correspondence', 'injection'], [withTools], []]],
			[{ kind: 'list', itemLabel: 'folder' }, [['/a', '/b'], []]],
			[
				{ kind: 'checks', ...events, allLabel: 'All events', emptyNote: 'Nothing.' },
				[all, [], ['idle-prompt']],
			],
		] as const
		for (const [control, list] of controls)
			for (const value of list)
				expect(
					cli.listControlWords(control as never, value),
					JSON.stringify([control.kind, value]),
				).toBe(values.listControlWords(control as never, value))
	})
})

describe('Desktop and the terminal read the routing table and the reviewer alike', () => {
	const routingControl = { kind: 'routing', example: '{}' }
	const autoControl = {
		kind: 'auto-mode',
		example: '{}',
		lists: [
			{ value: 'allow', label: 'Always allowed' },
			{ value: 'softDeny', label: 'Blocked unless you said so' },
			{ value: 'hardDeny', label: 'Always blocked' },
			{ value: 'environment', label: 'Trusted here' },
		],
	}
	const tables = [
		undefined,
		{},
		{ default: { provider: 'a', model: 'b' } },
		{
			default: { provider: 'a', model: 'b/c' },
			tiers: { fast: { provider: 'x', model: 'y' }, big: { provider: 'z', model: 'w' } },
			strategy: 'score',
			thresholds: { fast: 0.9 },
			timeoutMs: 1500,
		},
		{ model: 'smallModel', allow: ['$defaults', 'Run tests'], hardDeny: [] },
		{ hardDeny: ['$defaults', 'A'], environment: ['Our CI'] },
		'text',
	]

	it('answer every input the same way', async () => {
		const cli = (await import(/* @vite-ignore */ CLI)) as typeof values
		for (const text of ['a/b', ' a/b/c ', 'claude', '', '/x', 'a/'])
			expect(cli.routingTarget(text), text).toEqual(values.routingTarget(text))
		for (const text of ['1.5', '', '0', '10', '10.001', '11', 'x', '1.2345', '0.001', ' 2 '])
			expect(cli.timeoutFromSeconds(text), text).toEqual(values.timeoutFromSeconds(text))
		for (const ms of [1, 1500, 10_000])
			expect(cli.timeoutSeconds(ms)).toBe(values.timeoutSeconds(ms))
		for (const table of tables) {
			expect(cli.routingForm(table), JSON.stringify(table)).toEqual(values.routingForm(table))
			expect(cli.autoModeModel(table)).toBe(values.autoModeModel(table))
			for (const field of ['allow', 'hardDeny', 'environment'])
				expect(cli.autoModeList(table, field)).toEqual(values.autoModeList(table, field))
			expect(cli.autoModeSet(table, { model: undefined, allow: ['q'] })).toEqual(
				values.autoModeSet(table, { model: undefined, allow: ['q'] }),
			)
			for (const control of [routingControl, autoControl])
				expect(cli.listControlWords(control as never, table), JSON.stringify(table)).toBe(
					values.listControlWords(control as never, table),
				)
			for (const next of tables) {
				expect(cli.autoModeLoosened(table, next)).toEqual(values.autoModeLoosened(table, next))
				expect(cli.autoModeAsks(table, next)).toBe(values.autoModeAsks(table, next))
				expect(cli.autoModeConfirmation('Sentence.', table, next, autoControl.lists)).toBe(
					values.autoModeConfirmation('Sentence.', table, next, autoControl.lists),
				)
			}
		}
		for (const form of [
			{ default: 'a/b', fast: '', big: '', strategy: '', timeout: '' },
			{ default: 'a/b', fast: 'c/d', big: 'e/f', strategy: 'yesno', timeout: '2' },
			{ default: '', fast: 'c/d', big: '', strategy: 'score', timeout: '3' },
			{ default: 'a/b', fast: '', big: '', strategy: '', timeout: 'soon' },
		])
			for (const held of tables)
				expect(cli.routingValue(form, held)).toEqual(values.routingValue(form, held))
		for (const entry of ['$defaults', 'a sentence'])
			expect(cli.autoEntryLabel(entry)).toBe(values.autoEntryLabel(entry))
		const env = { variable: 'NAMZU_SMALL_MODEL', value: 'a/b' }
		expect(cli.environmentNote(env)).toBe(values.environmentNote(env))
	})
})
