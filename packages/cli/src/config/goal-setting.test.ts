import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function load(user?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('goal.confirmedBy', () => {
	it('is absent by default, which means the model’s report', () => {
		expect(load().goal).toBeUndefined()
	})

	it('reads record and model', () => {
		expect(load('goal:\n  confirmedBy: record\n').goal?.confirmedBy).toBe('record')
		expect(load('goal:\n  confirmedBy: model\n').goal?.confirmedBy).toBe('model')
	})

	it('refuses another value and another key, naming the key', () => {
		expect(() => load('goal:\n  confirmedBy: judge\n')).toThrow(ConfigValueError)
		expect(() => load('goal:\n  confirmedBy: judge\n')).toThrow(/confirmedBy/u)
		expect(() => load('goal:\n  maxRefusals: 2\n')).toThrow(/maxRefusals/u)
	})
})

describe('the goal limits', () => {
	it('reads the round backstop, the check-in, the budget, the stall count and the judge model', () => {
		const goal = load(
			'goal:\n  maxRounds: 400\n  checkInEvery: 20\n  tokenBudget: 750000\n  stallRounds: 4\n  judgeModel: openai/terra\n',
		).goal
		expect(goal).toEqual({
			maxRounds: 400,
			checkInEvery: 20,
			tokenBudget: 750_000,
			stallRounds: 4,
			judgeModel: 'openai/terra',
		})
	})

	it('reads 0 as no check-ins', () => {
		expect(load('goal:\n  checkInEvery: 0\n').goal?.checkInEvery).toBe(0)
	})

	it('refuses a number that is not a whole number in range, naming the key', () => {
		for (const [key, bad] of [
			['maxRounds', '0'],
			['maxRounds', '1.5'],
			['tokenBudget', '0'],
			['stallRounds', '0'],
			['checkInEvery', '-1'],
			['maxRounds', '"many"'],
		] as const) {
			expect(() => load(`goal:\n  ${key}: ${bad}\n`)).toThrow(new RegExp(key, 'u'))
		}
	})

	it('refuses an empty judge model', () => {
		expect(() => load('goal:\n  judgeModel: ""\n')).toThrow(/judgeModel/u)
	})
})
