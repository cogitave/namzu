import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
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
