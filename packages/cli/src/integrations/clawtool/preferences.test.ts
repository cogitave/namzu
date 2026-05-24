import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	PreferencesError,
	preferencesPath,
	readPreferences,
	writePreferences,
} from './preferences.js'

function tmpHome(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-prefs-'))
}

describe('readPreferences', () => {
	it('returns null when the file is missing (first-run signal)', () => {
		expect(readPreferences(tmpHome())).toBeNull()
	})
})

describe('writePreferences / round-trip', () => {
	it('persists and re-reads identical contents', () => {
		const home = tmpHome()
		const prefs = { version: 1 as const, default: 'claude', active: ['claude', 'codex'] }
		writePreferences(prefs, home)
		expect(readPreferences(home)).toEqual(prefs)
	})

	it('enforces mode 0600 on the file and 0700 on the directory', () => {
		const home = tmpHome()
		writePreferences({ version: 1, default: 'claude', active: ['claude'] }, home)
		const fileStat = statSync(preferencesPath(home))
		const dirStat = statSync(join(home, '.namzu'))
		expect(fileStat.mode & 0o777).toBe(0o600)
		expect(dirStat.mode & 0o777).toBe(0o700)
	})

	it('rejects default missing from active', () => {
		const home = tmpHome()
		expect(() =>
			writePreferences({ version: 1, default: 'claude', active: ['codex'] }, home),
		).toThrow(PreferencesError)
	})

	it('rejects an empty default', () => {
		const home = tmpHome()
		expect(() => writePreferences({ version: 1, default: '', active: [''] }, home)).toThrow(
			PreferencesError,
		)
	})

	it('rejects an unsupported version', () => {
		const home = tmpHome()
		expect(() =>
			writePreferences({ version: 99 as 1, default: 'claude', active: ['claude'] }, home),
		).toThrow(PreferencesError)
	})
})
