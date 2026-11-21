import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { PermissionLayer } from '../../config/load.js'
import {
	LEGACY_LOCAL_CONFIG_FILE,
	LOCAL_SETTINGS_FILE,
	legacyLocalConfigPath,
	localSettingsPath,
} from '../local-settings.js'
import {
	addLocalRule,
	removeLocalRule,
	renderRecentDenials,
	renderRules,
	ruleEntries,
} from '../rule-screen.js'

function folder(contents?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-rules-'))
	if (contents !== undefined) {
		mkdirSync(join(dir, '.namzu'))
		writeFileSync(localSettingsPath(dir), JSON.stringify(contents))
	}
	return dir
}

function localFile(dir: string): { permissions?: Record<string, unknown> } {
	return JSON.parse(readFileSync(localSettingsPath(dir), 'utf-8'))
}

describe('listing rules', () => {
	const layers: PermissionLayer[] = [
		{
			source: 'project-file',
			path: '/p/namzu.config.json',
			permissions: { bash: { 'git status *': 'allow', 'rm -rf *': 'deny' }, web_fetch: 'ask' },
		},
		{ source: 'local-file', path: '/p/local', permissions: { read: { './.env': 'deny' } } },
		{
			source: 'local-file',
			path: '/p/namzu.config.local.json',
			permissions: { edit: { 'docs/**': 'allow' } },
		},
	]

	it('names each rule once, with its file, grouped by what it does', () => {
		expect(renderRules(ruleEntries(layers))).toContain(
			[
				'Allowed without asking (2)',
				'  bash(git status *)  (this project)',
				'  edit(docs/**)  (this project, local (namzu.config.local.json))',
				'',
				'Always asks (1)',
				'  web_fetch  (this project)',
				'',
				'Never allowed (2)',
				'  bash(rm -rf *)  (this project)',
				'  read(./.env)  (this project, local)',
			].join('\n'),
		)
	})

	it('can show one group, and says when it is empty', () => {
		expect(renderRules(ruleEntries([]), 'deny')).toBe('Never allowed (0)\n  None.')
	})

	it('marks only the local file as removable', () => {
		const removable = ruleEntries(layers).filter((e) => e.removable)
		expect(removable.map((e) => e.rule)).toEqual(['edit(docs/**)', 'read(./.env)'])
	})
})

describe('adding a rule', () => {
	it('creates the local file with a pattern rule', () => {
		const dir = folder()
		expect(addLocalRule(dir, 'allow', 'Bash(git status:*)').ok).toBe(true)
		expect(localFile(dir).permissions).toEqual({ bash: { 'git status *': 'allow' } })
	})

	it('writes a whole-tool rule and keeps the patterns already there', () => {
		const dir = folder({ permissions: { bash: { 'ls *': 'allow' } }, theme: 'dark' })
		addLocalRule(dir, 'ask', 'Bash')
		expect(localFile(dir)).toMatchObject({
			theme: 'dark',
			permissions: { bash: { 'ls *': 'allow', '*': 'ask' } },
		})
	})

	it('turns a whole-tool rule into a table when a pattern is added', () => {
		const dir = folder({ permissions: { bash: 'ask' } })
		addLocalRule(dir, 'deny', 'Bash(rm -rf *)')
		expect(localFile(dir).permissions).toEqual({
			bash: { '*': 'ask', 'rm -rf *': 'deny' },
		})
	})

	it('refuses text that is not a rule, and a file that is not JSON', () => {
		const dir = folder()
		expect(addLocalRule(dir, 'allow', 'Bash(oops').ok).toBe(false)
		mkdirSync(join(dir, '.namzu'))
		writeFileSync(localSettingsPath(dir), '{nope')
		const result = addLocalRule(dir, 'allow', 'Bash')
		expect(result.ok).toBe(false)
		expect(readFileSync(localSettingsPath(dir), 'utf-8')).toBe('{nope')
	})

	it('writes the rule to .namzu/settings.local.json and says so', () => {
		const dir = folder()
		const result = addLocalRule(dir, 'allow', 'Bash(npm test *)')
		expect(result.message).toBe(`Added allow rule Bash(npm test *) to ${LOCAL_SETTINGS_FILE}.`)
		expect(existsSync(join(dir, LEGACY_LOCAL_CONFIG_FILE))).toBe(false)
	})

	it.each([
		['a user and password', 'Bash(curl -u admin:hunter2 https://example.com)'],
		['a bearer header', 'Bash(curl -H "Authorization: Bearer abcdefghijklmnop" https://x)'],
		['a password flag', 'Bash(mysql -uroot -psecret db)'],
		['a token value', 'Bash(deploy --token ghp_abcdefghijklmnopqrstuvwxyz0123)'],
	])('refuses a rule that holds %s, and writes nothing', (_what, rule) => {
		const dir = folder()
		const result = addLocalRule(dir, 'allow', rule)
		expect(result.ok).toBe(false)
		expect(result.message).toMatch(/password or a token/)
		expect(existsSync(localSettingsPath(dir))).toBe(false)
	})

	it('moves the earlier file first, so its rules stay and the new one joins them', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-rules-'))
		writeFileSync(
			legacyLocalConfigPath(dir),
			JSON.stringify({ permissions: { bash: { 'ls *': 'allow' } } }),
		)
		expect(addLocalRule(dir, 'deny', 'Bash(rm -rf *)').ok).toBe(true)
		expect(existsSync(legacyLocalConfigPath(dir))).toBe(false)
		expect(localFile(dir).permissions).toEqual({ bash: { 'ls *': 'allow', 'rm -rf *': 'deny' } })
	})

	it('refuses to save into a local file git tracks', () => {
		const dir = folder({ permissions: {} })
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
		execFileSync('git', ['init', '-q'], { cwd: dir, env })
		execFileSync('git', ['add', '-f', LOCAL_SETTINGS_FILE], { cwd: dir, env })
		const result = addLocalRule(dir, 'allow', 'Bash(ls *)')
		expect(result.ok).toBe(false)
		expect(result.message).toMatch(/^Git tracks \.namzu\/settings\.local\.json/)
		expect(localFile(dir).permissions).toEqual({})
	})
})

describe('removing a rule', () => {
	it('takes a pattern out and drops a table left empty', () => {
		const dir = folder({ permissions: { bash: { 'git status *': 'allow' } }, theme: 'dark' })
		expect(removeLocalRule(dir, 'Bash(git status *)').ok).toBe(true)
		expect(localFile(dir)).toEqual({ theme: 'dark' })
	})

	it('takes out a whole-tool rule, and a rule written in a list', () => {
		const dir = folder({ permissions: { web_fetch: 'ask', allow: ['Bash(ls *)', 'Read'] } })
		expect(removeLocalRule(dir, 'WebFetch').ok).toBe(true)
		expect(removeLocalRule(dir, 'Read').ok).toBe(true)
		expect(localFile(dir).permissions).toEqual({ allow: ['Bash(ls *)'] })
	})

	it('says so when the rule is not in the local file', () => {
		const dir = folder({ permissions: { bash: 'ask' } })
		const result = removeLocalRule(dir, 'Bash(ls *)')
		expect(result.ok).toBe(false)
		expect(result.message).toContain('No rule')
	})

	it('takes the rule out of the earlier file too, while that one is still read', () => {
		// Both files hold different settings, so neither moves: both are read, and both are edited.
		const dir = folder({ permissions: { bash: { 'git status *': 'allow' } } })
		writeFileSync(
			legacyLocalConfigPath(dir),
			JSON.stringify({
				theme: 'dark',
				permissions: { bash: { 'git status *': 'allow', 'ls *': 'allow' } },
			}),
		)
		const result = removeLocalRule(dir, 'Bash(git status *)')
		expect(result).toEqual({
			ok: true,
			message: `Removed Bash(git status *) from ${LOCAL_SETTINGS_FILE} and ${LEGACY_LOCAL_CONFIG_FILE}.`,
		})
		expect(localFile(dir)).toEqual({})
		expect(JSON.parse(readFileSync(legacyLocalConfigPath(dir), 'utf-8'))).toEqual({
			theme: 'dark',
			permissions: { bash: { 'ls *': 'allow' } },
		})
	})

	it('makes no .namzu folder when there is nothing to take out', () => {
		const dir = folder()
		expect(removeLocalRule(dir, 'Bash(ls *)').ok).toBe(false)
		expect(existsSync(join(dir, '.namzu'))).toBe(false)
	})
})

describe('recent denials', () => {
	it('say what will appear when there are none', () => {
		expect(renderRecentDenials([])).toContain('No recent denials')
	})

	it('list the call and the reason', () => {
		expect(
			renderRecentDenials([{ tool: 'bash', summary: 'curl x', reason: 'Sends data out.' }]),
		).toBe('Recently refused by auto mode (1, newest first)\n  bash: curl x\n    Sends data out.')
	})
})
