import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig, mergeTuiConfig } from './load.js'
import { SETTING_DESCRIPTORS } from './settings-descriptors.js'

function load(user?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('tui.syntaxHighlight', () => {
	it('is absent by default, which means on', () => {
		expect(load().tui?.syntaxHighlight).toBeUndefined()
	})

	it('reads an explicit false and an explicit true', () => {
		expect(load('tui:\n  syntaxHighlight: false\n').tui?.syntaxHighlight).toBe(false)
		expect(load('tui:\n  syntaxHighlight: true\n').tui?.syntaxHighlight).toBe(true)
	})

	it('refuses a value that is not true or false, naming the key', () => {
		expect(() => load('tui:\n  syntaxHighlight: "no"\n')).toThrow(ConfigValueError)
		expect(() => load('tui:\n  syntaxHighlight: "no"\n')).toThrow(/syntaxHighlight/u)
	})

	it('is the person’s own: a project file does not set it', () => {
		expect(mergeTuiConfig({ syntaxHighlight: true }, { syntaxHighlight: false }, true)).toEqual({
			syntaxHighlight: true,
		})
		expect(mergeTuiConfig(undefined, { syntaxHighlight: false }, false)).toEqual({
			syntaxHighlight: false,
		})
	})

	it('is listed with the other terminal settings, on by default', () => {
		const descriptor = SETTING_DESCRIPTORS.find((d) => d.path === 'tui.syntaxHighlight')
		expect(descriptor?.section).toBe('terminal')
		expect(descriptor?.defaultText).toBe('on')
	})
})
