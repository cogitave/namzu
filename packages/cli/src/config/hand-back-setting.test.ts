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

describe('handBack.enabled', () => {
	it('is absent by default, which means the tool is not offered', () => {
		expect(load().handBack).toBeUndefined()
	})

	it('reads true and false', () => {
		expect(load('handBack:\n  enabled: true\n').handBack?.enabled).toBe(true)
		expect(load('handBack:\n  enabled: false\n').handBack?.enabled).toBe(false)
	})

	it('refuses another value and another key, naming the key', () => {
		expect(() => load('handBack:\n  enabled: yes please\n')).toThrow(ConfigValueError)
		expect(() => load('handBack:\n  enabled: yes please\n')).toThrow(/enabled/u)
		expect(() => load('handBack:\n  always: true\n')).toThrow(/always/u)
	})

	it('is a described setting with default off', () => {
		const found = SETTING_DESCRIPTORS.find((d) => d.path === 'handBack.enabled')
		expect(found?.defaultText).toBe('off')
	})
})
