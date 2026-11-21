import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ConfigValueError, loadConfig } from './load.js'
import { findSetting } from './setting-cli.js'

function load(user?: string, project?: string) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	if (user !== undefined) writeFileSync(join(home, '.namzu', 'config.yaml'), user)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cwd-'))
	if (project !== undefined) {
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'config.yaml'), project)
	}
	return loadConfig({ home, cwd, env: {}, managedPath: join(cwd, 'managed.json') })
}

describe('network settings', () => {
	it('are absent by default, which means automatic, deliver, and the host name', () => {
		expect(load().network).toBeUndefined()
	})

	it('reads each value', () => {
		expect(load('network:\n  enabled: false\n').network).toEqual({ enabled: false })
		expect(load('network:\n  enabled: true\n').network).toEqual({ enabled: true })
		expect(load('network:\n  enabled: auto\n').network).toEqual({ enabled: 'auto' })
		expect(load('network:\n  acceptMail: hold\n  machineName: studio-air\n').network).toEqual({
			acceptMail: 'hold',
			machineName: 'studio-air',
		})
	})

	it('reads and checks autoAdmit', () => {
		for (const v of ['trusted-networks', 'always', 'never'])
			expect(load(`network:\n  autoAdmit: ${v}\n`).network).toEqual({ autoAdmit: v })
		expect(() => load('network:\n  autoAdmit: sometimes\n')).toThrow(/autoAdmit/u)
	})

	it('reads the text the Settings screen saves for a choice', () => {
		expect(load('network:\n  enabled: "false"\n').network).toEqual({ enabled: false })
		expect(load('network:\n  enabled: "true"\n').network).toEqual({ enabled: true })
	})

	it('refuses a bad value, naming the key', () => {
		for (const bad of [
			'network:\n  enabled: sometimes\n',
			'network:\n  acceptMail: all\n',
			`network:\n  machineName: ${'x'.repeat(41)}\n`,
			'network:\n  machineName: ""\n',
			'network:\n  port: 1\n',
			'network: yes\n',
		])
			expect(() => load(bad), bad).toThrow(ConfigValueError)
		expect(() => load('network:\n  acceptMail: all\n')).toThrow(/acceptMail/u)
	})

	it('are your own: a repository cannot open a listener on your machine', () => {
		const config = load(
			'network:\n  acceptMail: hold\n',
			'network:\n  enabled: true\n  acceptMail: members\n  machineName: pwned\n',
		)
		expect(config.network).toEqual({ acceptMail: 'hold' })
	})

	it('have a row each in Settings, in plain words', () => {
		for (const key of [
			'network.enabled',
			'network.acceptMail',
			'network.machineName',
			'network.autoAdmit',
		]) {
			const row = findSetting(key)
			expect(row, key).toBeDefined()
			expect(row?.keywords, key).toContain('peers')
		}
		expect(findSetting('network.enabled')?.default).toBe('auto')
		expect(findSetting('network.acceptMail')?.default).toBe('members')
		expect(findSetting('network.autoAdmit')?.default).toBe('trusted-networks')
	})
})
