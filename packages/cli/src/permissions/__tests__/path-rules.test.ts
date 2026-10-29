import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { type PermissionsConfig, compilePermissions } from '../rules.js'

const CWD = '/work/app'
const HOME = '/home/pat'

function decide(
	permissions: PermissionsConfig,
	toolName: string,
	path: string,
	context = { cwd: CWD, home: HOME },
) {
	const { rules } = compilePermissions(permissions, undefined, context)
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
	return gate.evaluate({ toolName, toolInput: { path }, toolDef: undefined })
}

describe('file rules read as paths', () => {
	it('match the same file however the call spells it', () => {
		const table: PermissionsConfig = { read: { './.env': 'deny' } }
		for (const spelling of ['.env', './.env', '/work/app/.env', 'src/../.env']) {
			expect(decide(table, 'read', spelling).decision).toBe('deny')
		}
		expect(decide(table, 'read', 'sub/.env').decision).toBe('review')
		expect(decide(table, 'read', '.env.example').decision).toBe('review')
	})

	it('keep * inside one folder and let ** cross folders', () => {
		const table: PermissionsConfig = { edit: { 'src/*.ts': 'allow', 'docs/**': 'allow' } }
		expect(decide(table, 'edit', 'src/a.ts').decision).toBe('allow')
		expect(decide(table, 'edit', 'src/deep/a.ts').decision).toBe('review')
		expect(decide(table, 'edit', 'docs/a/b/c.md').decision).toBe('allow')
	})

	it('start from the right place', () => {
		const table: PermissionsConfig = {
			read: { '//etc/hosts': 'deny', '~/.ssh/**': 'deny', '/secrets/**': 'deny' },
		}
		expect(decide(table, 'read', '/etc/hosts').decision).toBe('deny')
		expect(decide(table, 'read', '~/.ssh/id_ed25519').decision).toBe('deny')
		expect(decide(table, 'read', '/home/pat/.ssh/config').decision).toBe('deny')
		expect(decide(table, 'read', '/work/app/secrets/key.pem').decision).toBe('deny')
		expect(decide(table, 'read', '/secrets/key.pem').decision).toBe('review')
	})

	it('cover everything inside a folder that is named', () => {
		const table: PermissionsConfig = { edit: { build: 'deny' } }
		expect(decide(table, 'edit', 'build/out/main.js').decision).toBe('deny')
		expect(decide(table, 'edit', 'builder/main.js').decision).toBe('review')
	})

	it('apply to the sibling tools: edit covers write, read covers search and listing', () => {
		expect(decide({ edit: { '.env': 'deny' } }, 'write', '.env').decision).toBe('deny')
		expect(decide({ read: { '.env': 'deny' } }, 'grep', '.env').decision).toBe('deny')
		expect(decide({ read: { '.env': 'deny' } }, 'edit', '.env').decision).toBe('review')
	})

	it('ask for review and say which rule and path decided', () => {
		const result = decide({ read: { '*.pem': 'ask' } }, 'read', 'key.pem')
		expect(result.decision).toBe('review')
		expect(result.reason).toContain('/work/app/key.pem')
		expect(result.reason).toContain('*.pem')
	})

	it('let a narrower allow beat a broader deny of the same table', () => {
		const table: PermissionsConfig = { edit: { 'src/**': 'deny', 'src/gen/**': 'allow' } }
		expect(decide(table, 'edit', 'src/gen/a.ts').decision).toBe('allow')
		expect(decide(table, 'edit', 'src/a.ts').decision).toBe('deny')
	})

	it('treat an omitted search path as the working directory', () => {
		const { rules } = compilePermissions({ read: { '.env': 'deny' } }, undefined, { cwd: CWD })
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
		expect(
			gate.evaluate({ toolName: 'grep', toolInput: { pattern: 'x' }, toolDef: undefined }).decision,
		).toBe('deny')
	})

	it('keep a bare * meaning every call', () => {
		expect(decide({ read: { '*': 'allow' } }, 'read', '/anywhere/at/all').decision).toBe('allow')
	})

	it('read through a link to the file it leads to', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-path-rules-'))
		const cwd = join(root, 'project')
		mkdirSync(join(cwd, 'src'), { recursive: true })
		mkdirSync(join(root, 'outside'), { recursive: true })
		writeFileSync(join(root, 'outside', 'key'), 'x')
		writeFileSync(join(cwd, '.env'), 'x')
		symlinkSync(join(root, 'outside'), join(cwd, 'src', 'out'))
		symlinkSync(join(cwd, '.env'), join(cwd, 'src', 'plain'))
		const context = { cwd, home: HOME }
		// A link inside an allowed folder does not carry the allow out of it.
		expect(decide({ read: { 'src/**': 'allow' } }, 'read', 'src/out/key', context).decision).toBe(
			'review',
		)
		// A link to a denied file is the denied file.
		expect(decide({ read: { '.env': 'deny' } }, 'read', 'src/plain', context).decision).toBe('deny')
	})
})
