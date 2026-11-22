import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'
import { findSetting } from './setting-cli.js'
import { DEFAULT_SHOW_TURN_DURATION } from './turn-duration-default.js'

function load(user?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('tui.showTurnDuration', () => {
	it('is absent by default, and the default is on', () => {
		expect(load().tui?.showTurnDuration).toBeUndefined()
		expect(DEFAULT_SHOW_TURN_DURATION).toBe(true)
	})

	it('reads an explicit false and true', () => {
		expect(load('tui:\n  showTurnDuration: false\n').tui?.showTurnDuration).toBe(false)
		expect(load('tui:\n  showTurnDuration: true\n').tui?.showTurnDuration).toBe(true)
	})

	it('refuses a value that is not a boolean, naming the key', () => {
		expect(() => load('tui:\n  showTurnDuration: "no"\n')).toThrow(ConfigValueError)
		expect(() => load('tui:\n  showTurnDuration: "no"\n')).toThrow(/showTurnDuration/u)
	})

	it('is a described setting, so /config and the settings view list it', () => {
		const entry = findSetting('tui.showTurnDuration')
		expect(entry?.label).toBe('Show turn duration')
		expect(entry?.description).toBe(
			'Show how long each reply took and when it finished, after the reply',
		)
	})
})
