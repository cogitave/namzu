import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'

function layers(user?: string, env: Record<string, string> = {}) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	return { home, cwd, env, managedPath: join(cwd, 'managed.json') }
}

describe('refusalFallback', () => {
	it('is absent by default, which means auto', () => {
		expect(loadConfig(layers()).refusalFallback).toBeUndefined()
	})

	it.each(['auto', 'off'] as const)('accepts %s from the file', (value) => {
		expect(loadConfig(layers(`refusalFallback: ${value}\n`)).refusalFallback).toBe(value)
	})

	it('refuses any other value, naming the setting', () => {
		let error: unknown
		try {
			loadConfig(layers('refusalFallback: "sometimes"\n'))
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(ConfigValueError)
		expect(error).toMatchObject({ settingPath: 'refusalFallback' })
	})
})
