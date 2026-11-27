import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PluginRegistry } from '../../registry/plugin/index.js'
import { SkillRegistry } from '../../skills/registry.js'
import { CommonLayoutManifestSchema, PluginManifestSchema } from '../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import {
	COMMON_DATA_VARIABLE,
	COMMON_MANIFEST_DIR,
	COMMON_MCP_FILE,
	COMMON_PROJECT_VARIABLE,
	COMMON_ROOT_VARIABLE,
	ENTRY_SIDECAR_FILE,
} from '../common-layout-names.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import { discoverPlugins, loadPluginManifest, loadPluginManifestWithFindings } from '../loader.js'
import { runShellHook } from '../shell-hook.js'

const MANIFEST = `${COMMON_MANIFEST_DIR}/plugin.json`

function make(parent: string, name: string, files: Record<string, string | object>): string {
	const root = join(parent, name)
	mkdirSync(root, { recursive: true })
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
	}
	return root
}

const tmp = () => mkdtempSync(join(tmpdir(), 'namzu-layout-load-'))

const skill = (name: string, body = `Body of ${name}.`) =>
	`---\nname: ${name}\ndescription: Does ${name}.\n---\n${body}\n`

function manager(authority: string, skills?: SkillRegistry) {
	const pluginRegistry = new PluginRegistry()
	return new PluginLifecycleManager({
		pluginRegistry,
		scopeRoots: { project: authority, user: authority },
		log: NOOP_LOGGER,
		...(skills ? { skillRegistry: skills } : {}),
	})
}

describe('the loader reads the common layout when there is no plugin.json', () => {
	it('loads a folder with the common manifest, with the findings', async () => {
		const root = make(tmp(), 'ledger', {
			[MANIFEST]: {
				name: 'ledger',
				version: '1.0.0',
				description: 'Books.',
				themes: ['t'],
			},
			'skills/reconcile/SKILL.md': skill('reconcile'),
		})
		const loaded = await loadPluginManifestWithFindings(root, {
			skillsSupported: true,
		})
		expect(loaded.manifest).toMatchObject({
			name: 'ledger',
			skills: ['skills/reconcile'],
			layout: 'common',
		})
		expect(loaded.findings.some((f) => f.code === 'component-unsupported')).toBe(true)
		expect((await loadPluginManifest(root, { skillsSupported: true })).name).toBe('ledger')
	})

	it('loads a folder with only the conventional folders', async () => {
		const root = make(tmp(), 'just-skills', {
			'skills/a/SKILL.md': skill('a'),
		})
		const manifest = await loadPluginManifest(root, { skillsSupported: true })
		expect(manifest.name).toBe('just-skills')
	})

	it('still refuses skills when the host wired no skill registry', async () => {
		const root = make(tmp(), 'just-skills', {
			'skills/a/SKILL.md': skill('a'),
		})
		await expect(loadPluginManifest(root)).rejects.toThrow(/cannot enable/)
	})

	it('throws the reason for a refused plugin', async () => {
		const root = make(tmp(), 'themed', {
			[MANIFEST]: { name: 'themed', themes: ['t'] },
		})
		await expect(loadPluginManifest(root)).rejects.toThrow(/Nothing in themed is used by Namzu/)
		const empty = make(tmp(), 'nothing', { 'readme.txt': 'x' })
		await expect(loadPluginManifest(empty)).rejects.toThrow(/nothing here Namzu reads/i)
	})

	it('keeps a Namzu plugin.json as it was, and ignores a layout claim in it', async () => {
		const root = make(tmp(), 'native', {
			'plugin.json': {
				name: 'native',
				version: '1.0.0',
				description: 'n',
				layout: 'common',
			},
			[MANIFEST]: { name: 'other' },
		})
		const manifest = await loadPluginManifest(root)
		expect(manifest.name).toBe('native')
		expect(manifest.layout).toBeUndefined()
		expect(
			PluginManifestSchema.parse({
				name: 'n',
				version: '1',
				description: 'd',
				layout: 'common',
			}),
		).not.toHaveProperty('layout')
	})

	it('accepts 64 skills and 16 servers in the common layout only, and the remote form', () => {
		const base = { name: 'big', version: '1.0.0', description: 'd' }
		expect(
			CommonLayoutManifestSchema.safeParse({
				...base,
				skills: Array.from({ length: 64 }, (_, i) => `s${i}`),
			}).success,
		).toBe(true)
		expect(
			CommonLayoutManifestSchema.safeParse({
				...base,
				skills: Array.from({ length: 65 }, (_, i) => `s${i}`),
			}).success,
		).toBe(false)
		const servers = Array.from({ length: 16 }, (_, i) => ({
			name: `s${i}`,
			command: 'x',
		}))
		expect(CommonLayoutManifestSchema.safeParse({ ...base, mcpServers: servers }).success).toBe(
			true,
		)
		expect(
			CommonLayoutManifestSchema.safeParse({
				...base,
				mcpServers: [...servers, { name: 'z', command: 'x' }],
			}).success,
		).toBe(false)
		const remote = {
			name: 'r',
			url: 'https://a.example.com',
			transport: 'sse',
			headers: { A: 'b' },
		}
		expect(
			CommonLayoutManifestSchema.safeParse({
				...base,
				remoteMcpServers: [remote],
			}).success,
		).toBe(true)
		expect(
			CommonLayoutManifestSchema.safeParse({
				...base,
				remoteMcpServers: [{ ...remote, command: 'x' }],
			}).success,
		).toBe(false)
	})
	it('keeps the Namzu manifest limits for a plugin.json', () => {
		const base = { name: 'big', version: '1.0.0', description: 'd' }
		const skills = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`)
		expect(PluginManifestSchema.safeParse({ ...base, skills: skills(20) }).success).toBe(true)
		expect(PluginManifestSchema.safeParse({ ...base, skills: skills(21) }).success).toBe(false)
		expect(CommonLayoutManifestSchema.safeParse({ ...base, skills: skills(21) }).success).toBe(true)
	})
})

describe('discoverPlugins accepts the common manifest path', () => {
	it('admits a folder whose manifest is the common one, and still skips a bare folder', async () => {
		const parent = tmp()
		make(parent, 'common', { [MANIFEST]: { name: 'common' } })
		make(parent, 'native', {
			'plugin.json': { name: 'native', version: '1', description: 'd' },
		})
		make(parent, 'bare', { 'skills/a/SKILL.md': skill('a') })
		const found = await discoverPlugins(parent)
		expect(found.map((dir) => dir.slice(parent.length + 1)).sort()).toEqual(['common', 'native'])
	})

	it('refuses a linked manifest folder and a linked manifest file', async () => {
		const parent = tmp()
		const outside = make(tmp(), 'out', { 'plugin.json': { name: 'out' } })
		const folderLink = make(parent, 'folder-link', {})
		symlinkSync(outside, join(folderLink, COMMON_MANIFEST_DIR), 'dir')
		const fileLink = make(parent, 'file-link', {})
		mkdirSync(join(fileLink, COMMON_MANIFEST_DIR))
		symlinkSync(join(outside, 'plugin.json'), join(fileLink, MANIFEST))
		expect(await discoverPlugins(parent)).toEqual([])
	})
})

describe('the lifecycle admits a common-layout plugin', () => {
	it('installs and enables it, keeps its findings and its skill namespaced', async () => {
		const root = make(tmp(), 'ledger', {
			[MANIFEST]: { name: 'ledger', description: 'Books.', themes: ['t'] },
			'skills/reconcile/SKILL.md': skill(
				'reconcile',
				`Run \${${COMMON_ROOT_VARIABLE}}/scripts/go.sh now.`,
			),
		})
		const skills = new SkillRegistry(NOOP_LOGGER)
		const mgr = manager(root, skills)
		const plugin = await mgr.install(root, 'project')
		expect(plugin.manifest.layout).toBe('common')
		expect(mgr.layoutFindings(plugin.id).some((f) => f.field === 'themes')).toBe(true)
		await mgr.enable(plugin.id)
		expect(skills.has('ledger__reconcile')).toBe(true)
		const loaded = await skills.load('ledger__reconcile')
		expect(loaded?.skill.body).toContain(`Run ${root}/scripts/go.sh now.`)
		expect(loaded?.skill.body).not.toContain(COMMON_ROOT_VARIABLE)
	})

	it('puts the plugin folder in a skill body written with the Namzu name too', async () => {
		const root = make(tmp(), 'ledger', {
			[MANIFEST]: { name: 'ledger', description: 'Books.' },
			'skills/reconcile/SKILL.md': skill('reconcile', 'See ${NAMZU_PLUGIN_ROOT}/x and ${OTHER}.'),
		})
		const skills = new SkillRegistry(NOOP_LOGGER)
		const mgr = manager(root, skills)
		await mgr.enable((await mgr.install(root, 'project')).id)
		const body = (await skills.load('ledger__reconcile'))?.skill.body
		expect(body).toContain(`See ${root}/x and \${OTHER}.`)
	})

	it('reads servers with the data and project folders the host gives', async () => {
		const root = make(tmp(), 'srv', {
			[MANIFEST]: { name: 'srv' },
			[COMMON_MCP_FILE]: {
				db: {
					command: 'node',
					args: [`\${${COMMON_DATA_VARIABLE}}`, `\${${COMMON_PROJECT_VARIABLE}}`],
				},
				api: { url: 'https://mcp.example.com/' },
			},
		})
		const mgr = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			scopeRoots: { project: root, user: root },
			log: NOOP_LOGGER,
			pathValues: ({ name }) => ({ data: `/data/${name}` }),
		})
		const plugin = await mgr.install(root, 'project')
		expect(plugin.manifest.mcpServers).toEqual([
			{ name: 'db', command: 'node', args: ['/data/srv', root] },
		])
		expect(plugin.manifest.remoteMcpServers).toEqual([
			{ name: 'api', url: 'https://mcp.example.com/', transport: 'http' },
		])
	})

	it('admits a manifest the caller already read, still inside the authority root', async () => {
		const root = make(tmp(), 'given', { 'skills/a/SKILL.md': skill('a') })
		const mgr = manager(root, new SkillRegistry(NOOP_LOGGER))
		const plugin = await mgr.install(root, 'user', {
			authorityRoot: root,
			manifestSource: {
				manifest: {
					name: 'given',
					version: '9.9.9',
					description: 'From the record.',
					skills: ['skills/a'],
					layout: 'common',
				},
			},
		})
		expect(plugin.manifest).toMatchObject({
			name: 'given',
			version: '9.9.9',
			layout: 'common',
		})
		const outside = tmp()
		await expect(
			mgr.install(outside, 'user', {
				authorityRoot: root,
				manifestSource: {
					manifest: { name: 'x', version: '1', description: 'd' },
				},
			}),
		).rejects.toThrow(/escapes/i)
		await expect(
			mgr.install(root, 'user', {
				authorityRoot: root,
				manifestSource: {
					manifest: { name: 'Bad Name', version: '1', description: 'd' },
				},
			}),
		).rejects.toThrow()
	})
})

describe('the entry sidecar is reached only through an install record option', () => {
	const sidecar = {
		name: 'entry',
		description: 'From the entry.',
		strict: false,
		hooks: {
			PreToolUse: [{ hooks: [{ type: 'command', command: 'echo injected' }] }],
		},
		mcpServers: { evil: { command: 'rm' } },
	}

	it('a repository or hand-placed folder with a sidecar is not a plugin and injects nothing', async () => {
		const parent = tmp()
		const only = make(parent, 'only-sidecar', {
			[ENTRY_SIDECAR_FILE]: sidecar,
		})
		expect(await discoverPlugins(parent)).toEqual([])
		await expect(loadPluginManifest(only)).rejects.toThrow(/nothing here Namzu reads/i)
		const mgr = manager(only)
		await expect(mgr.install(only, 'project')).rejects.toThrow(/nothing here Namzu reads/i)

		const withSkills = make(parent, 'skills-and-sidecar', {
			'skills/a/SKILL.md': skill('a'),
			[ENTRY_SIDECAR_FILE]: sidecar,
		})
		const mgr2 = manager(withSkills, new SkillRegistry(NOOP_LOGGER))
		const plugin = await mgr2.install(withSkills, 'project')
		expect(plugin.manifest.hookEntries).toBeUndefined()
		expect(plugin.manifest.mcpServers).toBeUndefined()
		expect(plugin.manifest.name).toBe('skills-and-sidecar')
	})

	it('a folder with a common manifest and a sidecar is read from the manifest alone', async () => {
		const root = make(tmp(), 'both', {
			[MANIFEST]: { name: 'both', description: 'Own.' },
			'skills/a/SKILL.md': skill('a'),
			[ENTRY_SIDECAR_FILE]: { ...sidecar, name: 'both' },
		})
		const loaded = await loadPluginManifestWithFindings(root, {
			skillsSupported: true,
		})
		expect(loaded.manifest.hookEntries).toBeUndefined()
		expect(loaded.manifest.mcpServers).toBeUndefined()
		const withRecord = await loadPluginManifestWithFindings(root, {
			skillsSupported: true,
			commonLayout: { entrySidecar: true },
		})
		expect(Object.keys(withRecord.manifest.hookEntries ?? {})).toEqual(['PreToolUse'])
	})
})

describe('the hook environment of a common-layout plugin', () => {
	const input = {
		event: 'turn_start',
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		cwd: process.cwd(),
	} as const
	const dataDir = join(tmp(), 'data')
	// `env` names none of the variables, so the shape-based rule that fills a variable a
	// command mentions does not apply: what shows is what the process environment carries.
	const lines = async (plugin: {
		root: string
		dataDir: string
		layout?: 'common'
	}) =>
		(
			await runShellHook({ command: 'env' }, { ...input, projectDir: '/proj', plugin })
		).stdout.split('\n')

	it('also carries the three compatibility names, with the same values', async () => {
		const env = await lines({ root: '/p/root', dataDir, layout: 'common' })
		expect(env).toContain(`${COMMON_ROOT_VARIABLE}=/p/root`)
		expect(env).toContain(`${COMMON_DATA_VARIABLE}=${dataDir}`)
		expect(env).toContain(`${COMMON_PROJECT_VARIABLE}=/proj`)
		expect(env).toContain('NAMZU_PLUGIN_ROOT=/p/root')
		expect(env).toContain(`NAMZU_PLUGIN_DATA=${dataDir}`)
		expect(env).toContain('NAMZU_PROJECT_DIR=/proj')
	})

	it('does not widen the environment of a Namzu plugin', async () => {
		const env = await lines({ root: '/p/root', dataDir })
		expect(env.some((line) => line.startsWith(`${COMMON_ROOT_VARIABLE}=`))).toBe(false)
		expect(env.some((line) => line.startsWith(`${COMMON_DATA_VARIABLE}=`))).toBe(false)
		expect(env.some((line) => line.startsWith(`${COMMON_PROJECT_VARIABLE}=`))).toBe(false)
		expect(env).toContain('NAMZU_PLUGIN_ROOT=/p/root')
	})
})
