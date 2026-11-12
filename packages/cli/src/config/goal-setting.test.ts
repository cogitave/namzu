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
