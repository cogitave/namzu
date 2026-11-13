import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'
import { SETTING_DESCRIPTORS } from './settings-descriptors.js'

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

describe('tui.wheelRows and tui.wheelAccel', () => {
	it('are absent by default', () => {
		expect(load().tui?.wheelRows).toBeUndefined()
		expect(load().tui?.wheelAccel).toBeUndefined()
	})

	it('reads them', () => {
		const tui = load('tui:\n  wheelRows: 5\n  wheelAccel: false\n').tui
		expect(tui?.wheelRows).toBe(5)
		expect(tui?.wheelAccel).toBe(false)
	})

	it.each(['0', '21', '2.5', '"3"'])('refuses wheelRows: %s, naming the key', (value) => {
		expect(() => load(`tui:\n  wheelRows: ${value}\n`)).toThrow(ConfigValueError)
		expect(() => load(`tui:\n  wheelRows: ${value}\n`)).toThrow(/wheelRows/u)
	})

	it('refuses a wheelAccel that is not true or false', () => {
		expect(() => load('tui:\n  wheelAccel: fast\n')).toThrow(/wheelAccel/u)
	})

	it('are shown in the settings list with their bounds', () => {
		const rows = SETTING_DESCRIPTORS.filter((d) => d.path.startsWith('tui.wheel'))
		expect(rows.map((d) => d.path).sort()).toEqual(['tui.wheelAccel', 'tui.wheelRows'])
		const rowsControl = rows.find((d) => d.path === 'tui.wheelRows')?.control
		expect(rowsControl).toMatchObject({ kind: 'number', min: 1, max: 20 })
	})
})
