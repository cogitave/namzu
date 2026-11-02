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

describe('tui.mouse and tui.copyOnSelect', () => {
	it('are absent by default', () => {
		expect(load().tui?.mouse).toBeUndefined()
		expect(load().tui?.copyOnSelect).toBeUndefined()
	})

	it.each(['full', 'scroll', 'off'])('reads mouse: %s', (value) => {
		expect(load(`tui:\n  mouse: ${value}\n`).tui?.mouse).toBe(value)
	})

	it('reads copyOnSelect', () => {
		expect(load('tui:\n  copyOnSelect: false\n').tui?.copyOnSelect).toBe(false)
	})

	it('refuses other values, naming the key', () => {
		expect(() => load('tui:\n  mouse: clicks\n')).toThrow(ConfigValueError)
		expect(() => load('tui:\n  mouse: clicks\n')).toThrow(/mouse/u)
		expect(() => load('tui:\n  copyOnSelect: maybe\n')).toThrow(/copyOnSelect/u)
	})
})
