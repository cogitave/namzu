/**
 * The folder's settings files: `namzu.config.json` and `.namzu/settings.json`
 * are both the project layer, `.namzu/settings.local.json` and its earlier name
 * `namzu.config.local.json` both the local layer, and every reader takes the
 * same list.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthorizationGate, NOOP_LOGGER } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { describeFolderFiles } from '../doctor/checks/folder-files.js'
import { readFolderGrants } from '../integrations/trust/folder-grants.js'
import { projectFilesDeclaringWorktreeCreate } from '../integrations/worktrees/untrusted-hook.js'
import { compilePermissionLayers } from '../permissions/rules.js'
import { computeProjectDigest } from '../schedule/store/digest.js'
import {
	loadBootstrapConfigWithProvenance,
	loadConfigWithProvenance,
	readPermissionLayers,
} from './load.js'
import {
	bothFilesNotes,
	folderConfigFiles,
	folderFileRoot,
	isFolderConfigPath,
	presentFolderFiles,
} from './project-files.js'
import { layerReader } from './setting-layers.js'

function folder(files: Record<string, unknown>): { cwd: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), 'namzu-folder-files-'))
	const cwd = join(root, 'work')
	const home = join(root, 'home')
	mkdirSync(join(cwd, '.namzu'), { recursive: true })
	mkdirSync(home, { recursive: true })
	for (const [name, value] of Object.entries(files))
		writeFileSync(join(cwd, ...name.split('/')), JSON.stringify(value))
	return { cwd, home }
}

const load = (cwd: string, home: string) => loadConfigWithProvenance({ cwd, home, env: {} })

describe('the project layer', () => {
	it('reads .namzu/settings.json over namzu.config.json, key by key', () => {
		const { cwd, home } = folder({
			'namzu.config.json': { quiet: true, limits: { maxIterations: 5 } },
			'.namzu/settings.json': { quiet: false },
		})
		const { config, provenance } = load(cwd, home)
		expect(config.quiet).toBe(false)
		expect(provenance.quiet).toEqual({
			kind: 'project-file',
			path: join(cwd, '.namzu', 'settings.json'),
		})
		expect(config.limits?.maxIterations).toBe(5)
	})

	it('joins the permission tables of both, so a deny in either holds', () => {
		const { cwd, home } = folder({
			'namzu.config.json': { permissions: { bash: { 'rm *': 'deny' } } },
			'.namzu/settings.json': { permissions: { bash: { 'rm *': 'allow', 'ls *': 'allow' } } },
		})
		const layers = readPermissionLayers({ cwd, home, env: {} })
		expect(layers.map((layer) => [layer.source, layer.path])).toEqual([
			['project-file', join(cwd, 'namzu.config.json')],
			['project-file', join(cwd, '.namzu', 'settings.json')],
		])
		const { rules } = compilePermissionLayers(
			layers.map((layer) => layer.permissions),
			undefined,
			{ cwd },
		)
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
		const decide = (command: string) =>
			gate.evaluate({
				toolName: 'bash',
				toolInput: { command },
				toolDef: undefined,
				commandDialect: 'sh',
			}).decision
		expect(decide('rm -rf build')).toBe('deny')
		expect(decide('ls src')).toBe('allow')
	})

	it('holds .namzu/settings.json to the limits of a project file', () => {
		const { cwd, home } = folder({ '.namzu/settings.json': { model: 'auto', quiet: true } })
		const { config } = load(cwd, home)
		expect(config.model).toBeUndefined()
		expect(config.quiet).toBe(true)
	})

	it('is not read before the folder is trusted', () => {
		const { cwd, home } = folder({ '.namzu/settings.json': { quiet: true } })
		const { provenance } = loadBootstrapConfigWithProvenance({ cwd, home, env: {} })
		expect(provenance.quiet?.kind).not.toBe('project-file')
		expect(load(cwd, home).provenance.quiet?.kind).toBe('project-file')
	})

	it('attaches the hooks of both files, each named by its file', () => {
		const hook = (command: string) => ({ session_start: [{ command }] })
		const { cwd, home } = folder({
			'namzu.config.json': { hooks: hook('echo one') },
			'.namzu/settings.json': { hooks: hook('echo two') },
		})
		const entries = load(cwd, home).config.hooks?.session_start ?? []
		expect(entries.map((entry) => ('command' in entry ? entry.command : undefined))).toEqual([
			'echo one',
			'echo two',
		])
		expect(entries.map((entry) => entry.source)).toEqual([
			expect.stringMatching(/namzu\.config\.json$/),
			expect.stringMatching(/\.namzu\/settings\.json$/),
		])
	})

	it('names the file a bad value is in', () => {
		const { cwd, home } = folder({})
		writeFileSync(join(cwd, '.namzu', 'settings.json'), '{ nope')
		expect(() => load(cwd, home)).toThrow(
			/\.namzu\/settings\.json in this project isn't valid JSON/,
		)
	})
})

describe('the local layer', () => {
	it('reads .namzu/settings.local.json over namzu.config.local.json, over the project files', () => {
		const { cwd, home } = folder({
			'.namzu/settings.json': { quiet: true },
			'namzu.config.local.json': { quiet: false, limits: { maxIterations: 3 } },
			'.namzu/settings.local.json': { limits: { maxIterations: 9 } },
		})
		const { config, provenance } = load(cwd, home)
		expect(config.quiet).toBe(false)
		expect(provenance.quiet).toEqual({
			kind: 'local-file',
			path: join(cwd, 'namzu.config.local.json'),
		})
		expect(config.limits?.maxIterations).toBe(9)
	})

	it('reads a relative path rule against the project folder, not the .namzu folder', () => {
		const { cwd, home } = folder({
			'.namzu/settings.local.json': { permissions: { read: { './secret.txt': 'deny' } } },
		})
		const layers = readPermissionLayers({ cwd, home, env: {} })
		const { rules } = compilePermissionLayers(
			layers.map((layer) => layer.permissions),
			undefined,
			{ cwd },
		)
		const gate = new AuthorizationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: true,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			NOOP_LOGGER,
		)
		const decide = (path: string) =>
			gate.evaluate({ toolName: 'read', toolInput: { path }, toolDef: undefined }).decision
		expect(decide(join(cwd, 'secret.txt'))).toBe('deny')
		expect(decide(join(cwd, '.namzu', 'secret.txt'))).not.toBe('deny')
	})
})

describe('the file list every reader takes', () => {
	it('names the four files, project first, and knows them by path', () => {
		const { cwd } = folder({})
		expect(folderConfigFiles(cwd).map((file) => [file.name, file.layer])).toEqual([
			['namzu.config.json', 'project'],
			['.namzu/settings.json', 'project'],
			['namzu.config.local.json', 'local'],
			['.namzu/settings.local.json', 'local'],
		])
		for (const file of folderConfigFiles(cwd)) expect(isFolderConfigPath(file.path)).toBe(true)
		expect(isFolderConfigPath(join(cwd, 'settings.json'))).toBe(false)
		expect(folderFileRoot(join(cwd, '.namzu', 'settings.local.json'))).toBe(cwd)
		expect(folderFileRoot(join(cwd, 'namzu.config.json'))).toBe(cwd)
		expect(folderFileRoot(join(cwd, '.namzu', 'config.yaml'))).toBe(join(cwd, '.namzu'))
	})

	it('shows the trust screen the allow rules and hooks of every file', () => {
		const { cwd } = folder({
			'.namzu/settings.json': {
				permissions: { bash: { 'make *': 'allow' } },
				hooks: { session_start: [{ command: 'echo shared' }] },
			},
			'.namzu/settings.local.json': { permissions: { bash: { 'npm test *': 'allow' } } },
			'namzu.config.local.json': { permissions: { bash: { 'git log *': 'allow' } } },
		})
		const grants = readFolderGrants(cwd)
		expect(grants.allowRules).toEqual(['bash(make *)', 'bash(git log *)', 'bash(npm test *)'])
		expect(grants.hooks.map((hook) => hook.runs)).toContain('echo shared')
	})

	it('finds a worktree_create hook in any of them', () => {
		const { cwd } = folder({
			'.namzu/settings.local.json': { hooks: { worktree_create: [{ command: 'make tree' }] } },
		})
		expect(projectFilesDeclaringWorktreeCreate(cwd)).toEqual(['.namzu/settings.local.json'])
	})

	it('has the settings layers report the stronger file of each layer', () => {
		const { cwd } = folder({
			'namzu.config.json': { tui: { theme: 'dark' }, quiet: true },
			'.namzu/settings.json': { quiet: false },
		})
		const read = layerReader({ cwd, env: {} })
		expect(read('quiet')).toEqual({ layer: 'project', effective: false })
	})
})

describe('two files of one kind', () => {
	it('are named by namzu doctor and kept apart in its sentence', () => {
		const { cwd } = folder({
			'namzu.config.json': { quiet: true },
			'.namzu/settings.json': { quiet: false },
		})
		expect(presentFolderFiles(cwd, 'project').map((file) => file.name)).toEqual([
			'namzu.config.json',
			'.namzu/settings.json',
		])
		const result = describeFolderFiles(cwd)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('Both namzu.config.json and .namzu/settings.json are read')
		expect(bothFilesNotes(cwd)).toHaveLength(1)
	})

	it('are only named, not read, in a folder that is not trusted', () => {
		const { cwd } = folder({ 'namzu.config.json': {}, '.namzu/settings.json': {} })
		expect(describeFolderFiles(cwd, false)).toEqual({
			status: 'pass',
			message:
				'This folder is not trusted, so its settings files are not read: namzu.config.json, .namzu/settings.json.',
		})
	})

	it('pass quietly when each kind has one', () => {
		const { cwd } = folder({ '.namzu/settings.json': {}, '.namzu/settings.local.json': {} })
		expect(describeFolderFiles(cwd)).toEqual({
			status: 'pass',
			message:
				'Settings files read in this folder: .namzu/settings.json, .namzu/settings.local.json.',
		})
	})

	it('do not count a local copy that holds the same settings', () => {
		const { cwd } = folder({
			'namzu.config.local.json': { quiet: true },
			'.namzu/settings.local.json': { quiet: true },
		})
		expect(bothFilesNotes(cwd)).toEqual([])
	})
})

describe('a scheduled job', () => {
	it('pins .namzu/settings.json when it runs something, and keeps old digests otherwise', () => {
		const plain = folder({ 'namzu.config.json': { hooks: { session_start: [{ command: 'x' }] } } })
		expect(Object.keys(computeProjectDigest(plain.cwd).files)).toEqual([
			'namzu.config.json',
			'.namzu/commands',
			'.namzu/plugins',
		])
		const shared = folder({
			'.namzu/settings.json': { hooks: { session_start: [{ command: 'x' }] } },
		})
		expect(computeProjectDigest(shared.cwd).files['.namzu/settings.json']).toMatch(/^[0-9a-f]{64}$/)
	})
})
