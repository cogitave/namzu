import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
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
	return mkdtempSync(join(tmpdir(), 'namzu-prefs-v2-'))
}

describe('readPreferences', () => {
	it('reports missing when the file is absent', () => {
		expect(readPreferences(tmpHome())).toEqual({ status: 'missing' })
	})

	it('detects a v1 file as needs-repick (legacy schema)', () => {
		const home = tmpHome()
		mkdirSync(join(home, '.namzu'))
		writeFileSync(
			join(home, '.namzu', 'preferences.json'),
			JSON.stringify({ version: 1, default: 'claude', active: ['claude'] }),
		)
		const r = readPreferences(home)
		expect(r.status).toBe('needs-repick')
		if (r.status === 'needs-repick') {
			expect(r.reason).toMatch(/older schema/)
		}
	})

	it('round-trips a v2 selection', () => {
		const home = tmpHome()
		writePreferences({ version: 2, provider: 'anthropic', model: 'claude-opus-4-7' }, home)
		const r = readPreferences(home)
		expect(r.status).toBe('ok')
		if (r.status === 'ok') {
			expect(r.prefs.provider).toBe('anthropic')
			expect(r.prefs.model).toBe('claude-opus-4-7')
		}
	})

	it('throws on unparseable JSON', () => {
		const home = tmpHome()
		mkdirSync(join(home, '.namzu'))
		writeFileSync(join(home, '.namzu', 'preferences.json'), '{ not json')
		expect(() => readPreferences(home)).toThrow(PreferencesError)
	})
})

describe('writePreferences', () => {
	it('enforces mode 0600 on file and 0700 on dir', () => {
		const home = tmpHome()
		writePreferences({ version: 2, provider: 'openai' }, home)
		const fileMode = statSync(preferencesPath(home)).mode & 0o777
		const dirMode = statSync(join(home, '.namzu')).mode & 0o777
		expect(fileMode).toBe(0o600)
		expect(dirMode).toBe(0o700)
	})

	it('rejects an empty provider', () => {
		expect(() => writePreferences({ version: 2, provider: '' as never }, tmpHome())).toThrow(
			PreferencesError,
		)
	})

	it('preserves subagents.active when present', () => {
		const home = tmpHome()
		writePreferences(
			{
				version: 2,
				provider: 'anthropic',
				subagents: { active: ['claude', 'codex'] },
			},
			home,
		)
		const r = readPreferences(home)
		if (r.status === 'ok') {
			expect(r.prefs.subagents?.active).toEqual(['claude', 'codex'])
		} else {
			throw new Error('expected ok status')
		}
	})
})
