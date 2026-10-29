import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { PermissionLayer } from '../../config/load.js'
import { LOCAL_CONFIG_FILE } from '../local-settings.js'
import {
	addLocalRule,
	removeLocalRule,
	renderRecentDenials,
	renderRules,
	ruleEntries,
} from '../rule-screen.js'

function folder(contents?: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-rules-'))
	if (contents !== undefined) writeFileSync(join(dir, LOCAL_CONFIG_FILE), JSON.stringify(contents))
	return dir
}

function localFile(dir: string): { permissions?: Record<string, unknown> } {
	return JSON.parse(readFileSync(join(dir, LOCAL_CONFIG_FILE), 'utf-8'))
}

describe('listing rules', () => {
	const layers: PermissionLayer[] = [
		{
			source: 'project-file',
			path: '/p/namzu.config.json',
			permissions: { bash: { 'git status *': 'allow', 'rm -rf *': 'deny' }, web_fetch: 'ask' },
		},
		{ source: 'local-file', path: '/p/local', permissions: { read: { './.env': 'deny' } } },
	]

	it('names each rule once, with its file, grouped by what it does', () => {
		expect(renderRules(ruleEntries(layers))).toContain(
			[
				'Allowed without asking (1)',
				'  bash(git status *)  (this project)',
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
		expect(removable.map((e) => e.rule)).toEqual(['read(./.env)'])
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
		writeFileSync(join(dir, LOCAL_CONFIG_FILE), '{nope')
		const result = addLocalRule(dir, 'allow', 'Bash')
		expect(result.ok).toBe(false)
		expect(readFileSync(join(dir, LOCAL_CONFIG_FILE), 'utf-8')).toBe('{nope')
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
