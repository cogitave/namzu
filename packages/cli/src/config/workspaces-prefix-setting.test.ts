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

describe('tui.workspacesPrefix', () => {
	it('is absent by default, which means ctrl+b', () => {
		expect(load().tui?.workspacesPrefix).toBeUndefined()
	})

	it('reads a ctrl key', () => {
		expect(load('tui:\n  workspacesPrefix: ctrl+a\n').tui?.workspacesPrefix).toBe('ctrl+a')
	})

	it.each(['ctrl+c', 'alt+b', 'b'])('refuses %s, naming the key', (value) => {
		expect(() => load(`tui:\n  workspacesPrefix: ${value}\n`)).toThrow(ConfigValueError)
		expect(() => load(`tui:\n  workspacesPrefix: ${value}\n`)).toThrow(/workspacesPrefix/u)
	})
})

describe('tui.spacesPrefix (the name from before the rename)', () => {
	it('is still honoured when the new key is absent', () => {
		expect(load('tui:\n  spacesPrefix: ctrl+a\n').tui?.workspacesPrefix).toBe('ctrl+a')
	})

	it('loses to the new key when both are set', () => {
		expect(
			load('tui:\n  spacesPrefix: ctrl+a\n  workspacesPrefix: ctrl+e\n').tui?.workspacesPrefix,
		).toBe('ctrl+e')
	})

	it('is refused when it is not a usable key, naming the old key', () => {
		expect(() => load('tui:\n  spacesPrefix: ctrl+c\n')).toThrow(/spacesPrefix/u)
	})
})
