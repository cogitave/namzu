import { describe, expect, it } from 'vitest'

import { formatUsageError, wrapAtWords } from './usage-error.js'

describe('a command-line mistake', () => {
	it('reads as sentences in sentence case, with one pointer to --help', () => {
		expect(
			formatUsageError(
				"error: option '--effort <level>' argument 'turbo' is invalid. Allowed choices are none, minimal, low.\n",
				200,
			),
		).toBe(
			'“turbo” is not a valid value for --effort. Choose one of none, minimal, low.\nRun namzu --help to see what is available.\n',
		)
	})

	it('names the long flag when the option has a short one', () => {
		expect(
			formatUsageError("error: option '-f, --format <type>' argument 'xml' is invalid.\n", 200),
		).toContain('for --format.')
	})

	it('capitalises and ends a short complaint', () => {
		expect(formatUsageError("error: unknown option '--nope'\n", 200)).toBe(
			"Unknown option '--nope'.\nRun namzu --help to see what is available.\n",
		)
		expect(formatUsageError("error: option '--model <id>' argument missing\n", 200)).toContain(
			'--model needs a value.',
		)
	})

	it('does not add a second pointer when the message already says where to go', () => {
		const text = 'error: unknown command \'run\'\nUse namzu exec "<prompt>" instead.\n'
		expect(formatUsageError(text, 200)).toBe(
			'Unknown command \'run\'.\nUse namzu exec "<prompt>" instead.\n',
		)
		expect(formatUsageError('error: try --help for options\n', 200)).toBe(
			'Try --help for options.\n',
		)
	})

	it('wraps at word boundaries and never inside a word', () => {
		const out = formatUsageError(
			"error: option '--effort <level>' argument 'turbo' is invalid. Allowed choices are none, minimal, low, medium, high, xhigh, max, ultra.\n",
			40,
		)
		for (const row of out.trimEnd().split('\n')) expect(row.length).toBeLessThanOrEqual(40)
		expect(out).toContain('ultra.')
		expect(out).toContain('xhigh,')
	})

	it('keeps a word longer than the width on its own row', () => {
		expect(wrapAtWords('see /a/very/long/path/that/never/ends/anywhere/at/all ok', 24)).toEqual([
			'see',
			'/a/very/long/path/that/never/ends/anywhere/at/all',
			'ok',
		])
	})
})
