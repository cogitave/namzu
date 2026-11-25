import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadConfig } from './load.js'

function folder(files: { user?: string; local?: object }) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-skillovr-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (files.user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), files.user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-skillovr-cwd-'))
	if (files.local) {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'settings.local.json'), JSON.stringify(files.local))
	}
	return { home, cwd, env: {}, managedPath: join(cwd, 'managed.json') }
}

describe('skills.overrides', () => {
	it('reads each state as written', () => {
		const config = loadConfig(
			folder({
				user: 'skills:\n  overrides:\n    a: name-only\n    b: user-only\n    c: off\n    d: on\n',
			}),
		)
		expect(config.skills?.overrides).toEqual({
			a: 'name-only',
			b: 'user-only',
			c: 'off',
			d: 'on',
		})
	})

	it('refuses a state it does not know, and a value that is not a mapping', () => {
		expect(() => loadConfig(folder({ user: 'skills:\n  overrides:\n    a: sometimes\n' }))).toThrow(
			/overrides/,
		)
		expect(() => loadConfig(folder({ user: 'skills:\n  overrides: yes\n' }))).toThrow(/overrides/)
	})

	it('the project local file adds to the user file instead of replacing it', () => {
		const config = loadConfig(
			folder({
				user: 'skills:\n  builtin: false\n  disabled:\n    - kept-off\n  overrides:\n    a: off\n',
				local: { skills: { overrides: { b: 'name-only', a: 'on' } } },
			}),
		)
		expect(config.skills).toEqual({
			builtin: false,
			disabled: ['kept-off'],
			overrides: { a: 'on', b: 'name-only' },
		})
	})
})
