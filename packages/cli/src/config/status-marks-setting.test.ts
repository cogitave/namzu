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

describe('statusMarks', () => {
	it('is absent by default, which means the marks show', () => {
		expect(load().statusMarks).toBeUndefined()
	})

	it('reads true and false and refuses anything else', () => {
		expect(load('statusMarks: false\n').statusMarks).toBe(false)
		expect(load('statusMarks: true\n').statusMarks).toBe(true)
		expect(() => load('statusMarks: sometimes\n')).toThrow(ConfigValueError)
	})

	it('is a described setting, on by default, that applies at once and says it costs no usage', () => {
		const found = SETTING_DESCRIPTORS.find((d) => d.path === 'statusMarks')
		expect(found?.default).toBe(true)
		expect(found?.appliesWhen).toBe('now')
		expect(found?.description).toMatch(/none of your model usage/u)
	})
})
