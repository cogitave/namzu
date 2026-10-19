import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	type PermissionsConfig,
	compilePermissionLayers,
	mergePermissionTables,
	permissionLayersOf,
} from '../permissions/rules.js'
import { loadConfigWithProvenance } from './load.js'

/**
 * The `[permissions]` tables of the user file, the project file and the managed
 * file are joined, not replaced, and a deny from any of them wins.
 *
 * Before this, a project table erased every key of the user's, and a managed
 * table erased everything below it, so the layer written to be the last word
 * could only ever restate its own rules.
 */

function layout(files: { user?: unknown; project?: unknown; managed?: unknown }) {
	const root = mkdtempSync(join(tmpdir(), 'namzu-layers-'))
	const home = join(root, 'home')
	const cwd = join(root, 'work')
	mkdirSync(join(home, '.namzu'), { recursive: true })
	mkdirSync(cwd, { recursive: true })
	if (files.user !== undefined)
		writeFileSync(join(home, '.namzu', 'config.yaml'), JSON.stringify(files.user), 'utf-8')
	if (files.project !== undefined)
		writeFileSync(join(cwd, 'namzu.config.json'), JSON.stringify(files.project), 'utf-8')
	const managedPath = join(root, 'managed.json')
	if (files.managed !== undefined)
		writeFileSync(managedPath, JSON.stringify(files.managed), 'utf-8')
	return { home, cwd, managedPath }
}

function decide(layers: readonly PermissionsConfig[], toolName: string, command: string) {
	const { rules } = compilePermissionLayers(layers)
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
	return gate.evaluate({ toolName, toolInput: { command }, toolDef: undefined }).decision
}

describe('loading the layers', () => {
	it('keeps the user deny when the project writes a table of its own', () => {
		const l = layout({
			user: { permissions: { bash: { 'git push*': 'deny' } } },
			project: { permissions: { bash: { 'npm test*': 'allow' }, edit: 'allow' } },
		})

		const { config } = loadConfigWithProvenance({
			home: l.home,
			cwd: l.cwd,
			managedPath: l.managedPath,
			env: {},
		})

		expect(config.permissionLayers).toHaveLength(2)
		expect(config.permissions).toEqual({
			bash: { 'git push*': 'deny', 'npm test*': 'allow' },
			edit: 'allow',
		})
		const layers = permissionLayersOf(config)
		expect(decide(layers, 'bash', 'git push origin main')).toBe('deny')
		expect(decide(layers, 'bash', 'npm test')).toBe('allow')
	})

	it('adds the managed table to the rules below it instead of replacing them', () => {
		const l = layout({
			user: { permissions: { bash: { 'git status*': 'allow' } } },
			managed: { permissions: { bash: { 'curl*': 'deny' } } },
		})

		const { config, provenance } = loadConfigWithProvenance({
			home: l.home,
			cwd: l.cwd,
			managedPath: l.managedPath,
			env: {},
		})

		const layers = permissionLayersOf(config)
		expect(decide(layers, 'bash', 'git status')).toBe('allow')
		expect(decide(layers, 'bash', 'curl https://example.com')).toBe('deny')
		expect(provenance.permissions).toEqual({ kind: 'managed', path: l.managedPath })
	})

	it('refuses permissionLayers written in a file', () => {
		const l = layout({ project: { permissionLayers: [{ bash: 'allow' }] } })

		expect(() =>
			loadConfigWithProvenance({
				home: l.home,
				cwd: l.cwd,
				managedPath: l.managedPath,
				env: {},
			}),
		).toThrow(/permissionLayers/)
	})
})

describe('deciding across layers', () => {
	it('a deny in any layer beats a narrower allow in another, whichever is higher', () => {
		const deny: PermissionsConfig = { bash: { 'git push*': 'deny' } }
		const allow: PermissionsConfig = { bash: { 'git push origin main': 'allow' } }

		expect(decide([deny, allow], 'bash', 'git push origin main')).toBe('deny')
		expect(decide([allow, deny], 'bash', 'git push origin main')).toBe('deny')
	})

	it('a whole-tool deny in a lower layer is not undone by a higher allow table', () => {
		expect(
			decide([{ bash: 'deny' }, { bash: { 'git status*': 'allow' } }], 'bash', 'git status'),
		).toBe('deny')
	})

	it('an ask in one layer beats an allow in another', () => {
		expect(
			decide([{ bash: { 'npm *': 'ask' } }, { bash: { 'npm test': 'allow' } }], 'bash', 'npm test'),
		).toBe('review')
	})

	it('a call no layer names is still left to the review default', () => {
		expect(decide([{ bash: { 'ls*': 'allow' } }, { edit: 'allow' }], 'bash', 'rm x')).toBe('review')
	})

	it('one layer behaves as it did: the narrower allow still beats its own broader deny', () => {
		const table: PermissionsConfig = {
			bash: { 'git push*': 'deny', 'git push origin main': 'allow' },
		}

		expect(decide([table], 'bash', 'git push origin main')).toBe('allow')
		expect(decide([table], 'bash', 'git push --force')).toBe('deny')
	})

	it('reports a bad pattern of a lower layer even when a higher layer decides', () => {
		const { diagnostics } = compilePermissionLayers([
			{ bash: { 'x*': 'maybe' as never } },
			{ bash: { 'ls*': 'allow' } },
		])

		expect(diagnostics.map((d) => d.message).join('\n')).toContain('expected "allow"')
	})
})

describe('the combined table', () => {
	it('keeps the stricter effect where two layers name the same pattern', () => {
		expect(
			mergePermissionTables([
				{ bash: { 'a*': 'allow', 'b*': 'deny' }, edit: 'ask' },
				{ bash: { 'a*': 'deny', 'b*': 'allow' }, edit: 'allow' },
			]),
		).toEqual({ bash: { 'a*': 'deny', 'b*': 'deny' }, edit: 'ask' })
	})

	it('turns a whole-tool effect and a table into one table with the effect as its star', () => {
		expect(mergePermissionTables([{ bash: 'deny' }, { bash: { 'git status*': 'allow' } }])).toEqual(
			{ bash: { '*': 'deny', 'git status*': 'allow' } },
		)
	})
})
