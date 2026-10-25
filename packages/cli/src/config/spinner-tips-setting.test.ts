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

describe('tui.spinnerTips', () => {
	it('is absent by default, which means on', () => {
		expect(load().tui?.spinnerTips).toBeUndefined()
	})

	it('reads an explicit false', () => {
		expect(load('tui:\n  spinnerTips: false\n').tui?.spinnerTips).toBe(false)
	})

	it('refuses a value that is not a boolean, naming the key', () => {
		expect(() => load('tui:\n  spinnerTips: "no"\n')).toThrow(ConfigValueError)
		expect(() => load('tui:\n  spinnerTips: "no"\n')).toThrow(/spinnerTips/u)
	})
})
