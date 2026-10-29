import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { foldRuleLists } from '../rule-strings.js'
import {
	type PermissionsConfig,
	bindPermissionTableToSource,
	compilePermissionLayers,
	compilePermissions,
} from '../rules.js'

const cwd = '/work/app'
const directories: string[] = []
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function gate(table: PermissionsConfig, executionCwd = cwd) {
	const { rules, diagnostics } = compilePermissions(table, undefined, {
		cwd: executionCwd,
	})
	expect(diagnostics).toEqual([])
	return new AuthorizationGate(
		{
			enabled: true,
			rules: [...rules],
			allowReadOnlyTools: true,
			denyDangerousPatterns: false,
			logDecisions: false,
		},
		NOOP_LOGGER,
	)
}

function decide(policy: AuthorizationGate, toolName: string, toolInput: object) {
	return policy.evaluate({ toolName, toolInput, toolDef: undefined }).decision
}

function folded(table: Record<string, unknown>): PermissionsConfig {
	const result = foldRuleLists(table)
	expect(result.problem).toBeUndefined()
	return result.table as PermissionsConfig
}

describe('PER-17: whole-tool lists keep table restrictions', () => {
	for (const whole of ['Read', 'Read()', 'Read(*)']) {
		it(`keeps a pattern deny alongside ${whole}, in either key order`, () => {
			for (const table of [
				{ read: { '.env': 'deny' }, allow: [whole] },
				{ allow: [whole], read: { '.env': 'deny' } },
			]) {
				const normalized = folded(table)
				expect(normalized).toEqual({ read: { '.env': 'deny', '*': 'allow' } })
				const policy = gate(normalized)
				expect(decide(policy, 'read', { path: '.env' })).toBe('deny')
				expect(decide(policy, 'read', { path: 'safe.txt' })).toBe('allow')
			}
		})
	}

	it('keeps ask rules, stricter wildcard collisions, and command restrictions', () => {
		expect(folded({ read: { '*.pem': 'ask' }, allow: ['Read'] })).toEqual({
			read: { '*.pem': 'ask', '*': 'allow' },
		})
		for (const effect of ['ask', 'deny'] as const) {
			expect(folded({ read: { '*': effect, '.env': 'deny' }, allow: ['Read'] })).toEqual({
				read: { '*': effect, '.env': 'deny' },
			})
		}
		const policy = gate(folded({ bash: { 'rm -rf *': 'deny' }, allow: ['Bash'] }))
		expect(decide(policy, 'bash', { command: 'rm -rf /tmp/test' })).toBe('deny')
		expect(decide(policy, 'bash', { command: 'echo safe' })).toBe('allow')
	})

	it('keeps canonical pattern denies beside legacy whole-tool allows', () => {
		const policy = gate(folded({ read: 'allow', deny: ['Read(.env)'] }))
		expect(decide(policy, 'read', { path: '.env' })).toBe('deny')
		expect(decide(policy, 'read', { path: 'safe.txt' })).toBe('allow')
	})
})

describe('PER-18: discovery cannot expose denied descendants', () => {
	const table: PermissionsConfig = {
		read: {
			'.env': 'deny',
			'secrets/**': 'deny',
			'**/*.pem': 'deny',
			'*': 'allow',
		},
		grep: 'allow',
		glob: 'allow',
		ls: 'allow',
	}

	for (const tool of ['grep', 'glob', 'ls']) {
		it(`refuses ${tool} on an ancestor, including the implicit root`, () => {
			const policy = gate(table)
			for (const path of [undefined, '', '.', cwd, 'secrets']) {
				expect(decide(policy, tool, { pattern: '**/*', recursive: true, path })).toBe('deny')
			}
		})
	}

	it('keeps safe sibling subtrees and single-file reads available', () => {
		const policy = gate({
			read: { 'secrets/**': 'deny', '*': 'allow' },
			grep: 'allow',
			glob: 'allow',
			ls: 'allow',
		})
		for (const tool of ['grep', 'glob', 'ls']) {
			expect(decide(policy, tool, { path: 'src', pattern: '**/*' })).toBe('allow')
		}
		expect(decide(policy, 'read', { path: 'README.md' })).toBe('allow')
		expect(decide(policy, 'read', { path: 'secrets/key' })).toBe('deny')
	})

	it('does not trust include filters, hidden-file flags or list depth as a boundary', () => {
		const policy = gate(table)
		expect(decide(policy, 'grep', { pattern: 'x', include: 'safe.txt' })).toBe('deny')
		expect(decide(policy, 'glob', { pattern: 'safe.txt', include_hidden: false })).toBe('deny')
		expect(decide(policy, 'ls', { recursive: false, max_depth: 1, all: false })).toBe('deny')
	})

	it('asks about restricted descendants before a whole-tool allow', () => {
		const policy = gate({
			read: { 'keys/**': 'ask', '*': 'allow' },
			grep: 'allow',
		})
		expect(decide(policy, 'grep', { pattern: 'x' })).toBe('review')
	})

	it('does not turn a tool denial into an approvable descendant review', () => {
		const policy = gate({ read: { 'keys/**': 'ask' }, grep: 'deny' })
		expect(decide(policy, 'grep', { pattern: 'x' })).toBe('deny')
	})

	it('keeps narrower same-layer allowances on a directly named subtree', () => {
		const policy = gate({
			read: { 'src/**': 'deny', 'src/public/**': 'allow' },
		})
		for (const tool of ['grep', 'glob', 'ls']) {
			for (const path of ['src/public', 'src/public/', 'src/public/nested']) {
				expect(decide(policy, tool, { path, pattern: 'x' })).toBe('allow')
			}
			for (const path of ['.', 'src', 'src/private']) {
				expect(decide(policy, tool, { path, pattern: 'x' })).toBe('deny')
			}
		}
	})

	it('keeps a descendant denial across layers and layer order', () => {
		for (const layers of [
			[{ read: { '.env': 'deny' } }, { grep: 'allow' }],
			[{ grep: 'allow' }, { read: { '.env': 'deny' } }],
		] as const) {
			const { rules } = compilePermissionLayers(layers, undefined, { cwd })
			const policy = new AuthorizationGate(
				{
					enabled: true,
					rules: [...rules],
					allowReadOnlyTools: true,
					denyDangerousPatterns: false,
					logDecisions: false,
				},
				NOOP_LOGGER,
			)
			expect(decide(policy, 'grep', { pattern: 'x' })).toBe('deny')
		}
	})

	it('checks the physical spelling of a search-root alias', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-permission-boundary-'))
		directories.push(root)
		mkdirSync(join(root, 'private'))
		writeFileSync(join(root, 'private', '.env'), 'secret')
		symlinkSync(join(root, 'private'), join(root, 'alias'))
		const policy = gate({ read: { 'private/.env': 'deny' }, grep: 'allow' }, root)
		expect(decide(policy, 'grep', { path: 'alias', pattern: 'secret' })).toBe('deny')
	})
})

describe('file policy roots belong to the settings source', () => {
	it('resolves rule paths at the source, but call paths at the execution cwd', () => {
		const table = bindPermissionTableToSource(
			{ read: { './.env': 'deny', '/keys/**': 'deny', '*': 'allow' } },
			'/settings/namzu.config.json',
		)
		const policy = gate(table, '/elsewhere')
		expect(decide(policy, 'read', { path: '/settings/.env' })).toBe('deny')
		expect(decide(policy, 'read', { path: '/settings/keys/key' })).toBe('deny')
		expect(decide(policy, 'read', { path: '.env' })).toBe('allow')
		expect(decide(policy, 'grep', { path: '/settings', pattern: 'x' })).toBe('deny')
	})

	it('retains each source root through layered compilation', () => {
		const layers = [
			bindPermissionTableToSource({ read: { '.env': 'deny' } }, '/one/config.yaml'),
			bindPermissionTableToSource({ read: { '.env': 'deny' } }, '/two/config.json'),
			{ read: 'allow' as const },
		]
		const { rules } = compilePermissionLayers(layers, undefined, {
			cwd: '/elsewhere',
		})
		const policy = new AuthorizationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: true,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			NOOP_LOGGER,
		)
		for (const path of ['/one/.env', '/two/.env']) {
			expect(decide(policy, 'read', { path })).toBe('deny')
		}
		expect(decide(policy, 'read', { path: '/elsewhere/.env' })).toBe('allow')
	})
})
