import { describe, expect, it } from 'vitest'

import { parseExecFlags } from './exec-flags.js'
import { parseResidentFlags } from './resident-flags.js'
import { describeSpendStop } from './run-flags.js'

describe('the per-run flags parse into the shared exec input', () => {
	it('keeps them out of the prompt and out of the unknown list', () => {
		const flags = parseExecFlags([
			'--append-system-prompt',
			'Be brief.',
			'--max-budget-usd=1.5',
			'--allowed-tools',
			'edit',
			'--allowed-tools=read',
			'--disallowed-tools',
			'bash(rm *)',
			'--fallback-model',
			'openai/a',
			'--fallback-model=b',
			'fix the build',
		])
		expect(flags).toMatchObject({
			appendSystemPrompt: 'Be brief.',
			maxBudgetUsd: 1.5,
			allowedTools: ['edit', 'read'],
			disallowedTools: ['bash(rm *)'],
			fallbackModels: ['openai/a', 'b'],
			unknown: [],
			rest: ['fix the build'],
		})
	})

	it('are absent by default', () => {
		expect(parseExecFlags(['go'])).toMatchObject({
			appendSystemPrompt: null,
			maxBudgetUsd: null,
			allowedTools: [],
			disallowedTools: [],
			fallbackModels: [],
		})
	})

	it.each(['0', '-1', 'lots', '', 'Infinity'])(
		'refuses a spend limit that is not a positive number of dollars: %j',
		(value) => {
			expect(() => parseExecFlags([`--max-budget-usd=${value}`])).toThrow('--max-budget-usd')
		},
	)

	it('are refused by a resident, which would otherwise ignore them', () => {
		for (const flag of [
			['--append-system-prompt', 'x'],
			['--max-budget-usd', '1'],
			['--allowed-tools', 'edit'],
			['--disallowed-tools', 'bash'],
			['--fallback-model', 'openai'],
		]) {
			expect(() => parseResidentFlags(['run', ...flag])).toThrow(/not to a resident/)
		}
	})
})

describe('describeSpendStop', () => {
	it('names the limit in dollars and how to raise it', () => {
		expect(describeSpendStop(0.5)).toBe(
			'stopped at the spend limit of $0.50; raise it with --max-budget-usd to let the run go on',
		)
		expect(describeSpendStop(0.002)).toContain('of $0.002;')
		expect(describeSpendStop(0.0000001)).toContain('of $0.0000001;')
		expect(describeSpendStop(12)).toContain('of $12.00;')
	})

	it('still says it stopped when the limit came from the config file', () => {
		expect(describeSpendStop(0)).toMatch(/^stopped at the spend limit;/)
	})
})

describe('the session flags parse into the shared exec input', () => {
	it('reads --fork-session and --no-session-persistence without touching the prompt', () => {
		expect(
			parseExecFlags(['--no-session-persistence', '--fork-session', '--continue', 'go on']),
		).toMatchObject({
			noSessionPersistence: true,
			forkSession: true,
			continueLast: true,
			unknown: [],
			rest: ['go on'],
		})
		expect(parseExecFlags(['go'])).toMatchObject({
			noSessionPersistence: false,
			forkSession: false,
		})
	})
})
