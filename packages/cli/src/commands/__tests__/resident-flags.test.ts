import { describe, expect, it } from 'vitest'
import { parseResidentFlags } from '../resident-flags.js'

describe('resident command argument boundaries', () => {
	it('preserves flag-shaped literal objectives after the option boundary', () => {
		const parsed = parseResidentFlags([
			'add',
			'--agent',
			'research',
			'--',
			'--max-steps',
			'unlimited',
			'--agent',
			'different',
		])
		expect(parsed.agent).toBe('research')
		expect(parsed.maxSteps).toBeNull()
		expect(parsed.run.rest).toEqual(['--max-steps', 'unlimited', '--agent', 'different'])
	})
	it.each([
		['--permission-mode', 'invalid'],
		['--gate-retries', '0'],
		['--gate', 'true', '--gate-retries', 'NaN'],
		['--gate-retries', '2'],
		['--max-iterations', '9007199254740992'],
		['--token-budget', '9007199254740992'],
		['--max-steps', '3'],
	])('refuses invalid or duplicate execution options before state admission: %j', (...options) => {
		expect(() => parseResidentFlags(['run', '--max-steps', '2', ...options])).toThrow()
	})
	it('does not save one invocation’s authority on an add operation', () => {
		expect(() => parseResidentFlags(['add', 'review', '--permission-mode', 'auto'])).toThrow(
			'apply to resident run',
		)
	})
	it('requires exact inspected recovery inputs', () => {
		expect(() => parseResidentFlags(['reconcile', 'id', 'checked', '--executor-stopped'])).toThrow(
			'requires',
		)
		expect(() => parseResidentFlags(['resume', '--executor-stopped'])).toThrow('apply to reconcile')
	})
})
