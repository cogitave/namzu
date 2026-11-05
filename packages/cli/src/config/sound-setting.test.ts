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

describe('tui.sound', () => {
	it('is absent unless the file says something, so the default (on) applies', () => {
		expect(load().tui?.sound).toBeUndefined()
	})

	it('reads an explicit false and true', () => {
		expect(load('tui:\n  sound: false\n').tui?.sound).toBe(false)
		expect(load('tui:\n  sound: true\n').tui?.sound).toBe(true)
	})

	it('keeps it beside the notification keys instead of replacing them', () => {
		const tui = load('tui:\n  sound: false\n  notifications: true\n').tui
		expect(tui?.sound).toBe(false)
		expect(tui?.notifications).toBe(true)
	})

	it('rejects a value that is not a boolean, naming the key', () => {
		expect(() => load('tui:\n  sound: "loud"\n')).toThrow(ConfigValueError)
		expect(() => load('tui:\n  sound: "loud"\n')).toThrow(/sound/u)
	})
})
