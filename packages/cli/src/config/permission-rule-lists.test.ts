import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { foldRuleLists, parseRuleString } from '../permissions/rule-strings.js'
import { compilePermissionLayers, permissionLayersOf } from '../permissions/rules.js'
import { loadConfigWithProvenance } from './load.js'

const settingsRoots = new WeakMap<object, string>()

function load(permissions: unknown) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-rule-lists-'))
	const home = join(root, 'home')
	const cwd = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify({ permissions }), 'utf-8')
	const config = loadConfigWithProvenance({
		home,
		cwd,
		managedPath: join(root, 'managed.json'),
		env: {},
	}).config
	settingsRoots.set(config, join(home, '.namzu'))
	return config
}

function decide(config: ReturnType<typeof load>, toolName: string, toolInput: object) {
	const { rules } = compilePermissionLayers(permissionLayersOf(config), undefined, { cwd: '/work' })
	const gate = new AuthorizationGate(
		{
			enabled: true,
			rules: [...rules],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
	return gate.evaluate({ toolName, toolInput, toolDef: undefined }).decision
}

describe('parseRuleString', () => {
	it('reads a bare tool, a specifier, and the whole-tool forms', () => {
		expect(parseRuleString('Bash')).toEqual({ tool: 'bash' })
		expect(parseRuleString('Bash(git push:*)')).toEqual({ tool: 'bash', specifier: 'git push:*' })
		expect(parseRuleString('Bash()')).toEqual({ tool: 'bash' })
		expect(parseRuleString('Bash(*)')).toEqual({ tool: 'bash' })
		expect(parseRuleString('WebFetch(domain:x.com)')).toEqual({
			tool: 'web_fetch',
			specifier: 'domain:x.com',
		})
		expect(parseRuleString('mcp__srv__tool')).toEqual({ tool: 'mcp__srv__tool' })
		expect(parseRuleString('Bash(echo \\(hi\\))')).toEqual({
			tool: 'bash',
			specifier: 'echo (hi)',
		})
	})

	it('refuses unbalanced or empty rules', () => {
		for (const bad of ['', 'Bash(', 'Bash(a))', '(a)', 'Bash(a) x', 'Ba(sh(a)']) {
			expect(parseRuleString(bad)).toBeUndefined()
		}
	})
})

describe('allow, ask and deny lists', () => {
	it('decide calls like the per-tool table does', () => {
		const config = load({
			allow: ['Bash(git status:*)', 'Read'],
			ask: ['Bash(git push *)'],
			deny: ['Bash(rm -rf *)', 'Read(./.env)'],
		})
		expect(config.permissions).toEqual({
			bash: { 'git status *': 'allow', 'git push *': 'ask', 'rm -rf *': 'deny' },
			read: { '*': 'allow', './.env': 'deny' },
		})
		expect(decide(config, 'bash', { command: 'git status' })).toBe('allow')
		expect(decide(config, 'bash', { command: 'git status -s' })).toBe('allow')
		expect(decide(config, 'bash', { command: 'git push origin main' })).toBe('review')
		expect(decide(config, 'bash', { command: 'rm -rf /tmp/x' })).toBe('deny')
		expect(decide(config, 'bash', { command: 'git statusx; rm -rf ~' })).toBe('deny')
		// Relative rules belong to the settings file, not an unrelated execution cwd.
		const settingsRoot = settingsRoots.get(config) as string
		expect(decide(config, 'read', { path: join(settingsRoot, '.env') })).toBe('deny')
		expect(decide(config, 'read', { path: join(settingsRoot, 'readme.md') })).toBe('allow')
		expect(decide(config, 'read', { path: '/work/.env' })).toBe('allow')
	})

	it('map a domain rule onto the fetch tool', () => {
		const config = load({ allow: ['WebFetch(domain:docs.example.com)'] })
		expect(decide(config, 'web_fetch', { url: 'https://docs.example.com/a', prompt: 'p' })).toBe(
			'allow',
		)
		expect(
			decide(config, 'web_fetch', { url: 'https://docs.example.com.evil.io/a', prompt: 'p' }),
		).not.toBe('allow')
	})

	it('mix with the table, and the stricter effect wins a clash', () => {
		const config = load({
			bash: { 'npm test*': 'allow' },
			allow: ['Edit', 'Bash(npm test*)'],
			deny: ['Edit', 'Bash(npm test*)'],
		})
		expect(config.permissions).toEqual({
			bash: { 'npm test*': 'deny' },
			edit: 'deny',
		})
	})

	it('keep an existing whole-tool effect beside new patterns', () => {
		const out = foldRuleLists({ bash: 'ask', allow: ['Bash(ls *)'] }).table
		expect(out).toEqual({ bash: { '*': 'ask', 'ls *': 'allow' } })
	})

	it('name the file and the entry that cannot be read', () => {
		expect(() => load({ allow: ['Bash(git status'] })).toThrow(/allow.*0.*not a rule/s)
		expect(() => load({ deny: [42] })).toThrow(/not a rule/)
	})

	it('leave a table without lists unchanged', () => {
		const table = { bash: { 'git push*': 'deny' }, defaultMode: 'prompt' }
		expect(foldRuleLists(table).table).toEqual(table)
	})
})
