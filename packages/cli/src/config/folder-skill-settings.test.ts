import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { writeSetting } from './desktop-settings.js'
import { findSetting, planSettingChange, readSettingRow, renderSetting } from './setting-cli.js'
import { needsConfirmation, widensList } from './setting-values.js'
import { userConfigPath } from './user-config.js'

let home: string
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-folder-skill-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))
const opts = () => ({ home, env: {} as NodeJS.ProcessEnv })
const saved = (): Record<string, unknown> => {
	try {
		return (parse(readFileSync(userConfigPath(opts()), 'utf8')) ?? {}) as Record<string, unknown>
	} catch {
		return {}
	}
}
function set(key: string, text: string) {
	const plan = planSettingChange(key, text, opts())
	if (!plan.ok) throw new Error(plan.error)
	return plan
}
const refusal = (key: string, text: string): string => {
	const plan = planSettingChange(key, text, opts())
	return plan.ok ? 'accepted' : plan.error
}

describe('the extra folders row', () => {
	it('is a folder list with the system picker, and its default is none', () => {
		const entry = findSetting('additionalDirectories')
		expect(entry?.control).toMatchObject({ kind: 'list', picker: 'folder' })
		expect(entry?.default).toEqual([])
		expect(entry?.confirmWhen).toBe('widens')
	})

	it('writes the same list of paths from words or from JSON', () => {
		set('additionalDirectories', '/data/a, /data/b').apply()
		expect(saved().additionalDirectories).toEqual(['/data/a', '/data/b'])
		set('additionalDirectories', '["/data/c"]').apply()
		expect(saved().additionalDirectories).toEqual(['/data/c'])
		writeSetting({ path: 'additionalDirectories', value: ['/data/d', ' /data/e '] }, opts())
		expect(saved().additionalDirectories).toEqual(['/data/d', '/data/e'])
	})

	it('removes the key for an empty list, since none is the default', () => {
		set('additionalDirectories', '/data/a').apply()
		set('additionalDirectories', 'none').apply()
		expect(saved().additionalDirectories).toBeUndefined()
		writeSetting({ path: 'additionalDirectories', value: ['/a'] }, opts())
		writeSetting({ path: 'additionalDirectories', value: [] }, opts())
		expect(saved().additionalDirectories).toBeUndefined()
	})

	it('refuses what the loader refuses, in the loader’s words', () => {
		expect(refusal('additionalDirectories', '[1]')).toMatch(/Enter a list of words|directory path/)
		expect(refusal('additionalDirectories', '{"a":1}')).not.toBe('accepted')
		expect(() => writeSetting({ path: 'additionalDirectories', value: [''] }, opts())).toThrow(
			/folder/,
		)
	})

	it('asks only when an entry is added, never when one is removed or the list stays', () => {
		const entry = findSetting('additionalDirectories')
		if (!entry) throw new Error('missing')
		expect(widensList(['/a'], ['/a', '/b'])).toBe(true)
		expect(widensList(['/a', '/b'], ['/a'])).toBe(false)
		expect(widensList(undefined, ['/a'])).toBe(true)
		expect(needsConfirmation(entry, ['/a', '/b'], ['/a'])).toBe(true)
		expect(needsConfirmation(entry, ['/a'], ['/a', '/b'])).toBe(false)
		expect(needsConfirmation(entry, undefined, ['/a'])).toBe(false)
		set('additionalDirectories', '/a').apply()
		expect(set('additionalDirectories', '/a, /b').confirm).toMatch(/reach this folder/)
		expect(set('additionalDirectories', '/a').confirm).toBeUndefined()
		expect(set('additionalDirectories', 'none').confirm).toBeUndefined()
	})

	it('says in words what it takes and holds', () => {
		set('additionalDirectories', '/a, /b').apply()
		expect(readSettingRow('additionalDirectories', opts()).valueText).toBe('/a, /b')
		expect(renderSetting(readSettingRow('additionalDirectories', opts()), 'f')).toMatch(
			/folders, comma separated/,
		)
	})
})

describe('the turned-off skills row', () => {
	it('is a list of names offered from the installed skills, and its default is none', () => {
		const entry = findSetting('skills.disabled')
		expect(entry?.control).toMatchObject({ kind: 'list', source: 'skills' })
		expect(entry?.default).toEqual([])
	})

	it('writes the names as a list from words or JSON', () => {
		set('skills.disabled', 'review-changes, browser-automation').apply()
		expect((saved().skills as Record<string, unknown>).disabled).toEqual([
			'review-changes',
			'browser-automation',
		])
		set('skills.disabled', '["one"]').apply()
		expect((saved().skills as Record<string, unknown>).disabled).toEqual(['one'])
	})

	it('removes the key when the last skill is turned back on', () => {
		writeSetting({ path: 'skills.disabled', value: ['a'] }, opts())
		writeSetting({ path: 'skills.disabled', value: [] }, opts())
		expect(saved().skills).toBeUndefined()
	})

	it('refuses what is not a list of names, as the loader does', () => {
		expect(refusal('skills.disabled', '[1,2]')).not.toBe('accepted')
		expect(() => writeSetting({ path: 'skills.disabled', value: ['  '] }, opts())).toThrow()
	})

	it('asks nothing: turning a skill off is not a risk', () => {
		expect(set('skills.disabled', 'a').confirm).toBeUndefined()
	})
})

describe('the tool servers row', () => {
	it('stays a file-only row in the terminal, where namzu mcp does the work', () => {
		const entry = findSetting('mcpServers')
		expect(entry?.control.kind).toBe('file-only')
		expect(entry?.description).toMatch(/namzu mcp/)
		expect(refusal('mcpServers', '{}')).toMatch(/config file/)
	})
})
