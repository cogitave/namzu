import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
	COMMON_DATA_VARIABLE,
	COMMON_MANIFEST_DIR,
	COMMON_MCP_FILE,
	COMMON_PROJECT_VARIABLE,
	COMMON_ROOT_VARIABLE,
	ENTRY_SIDECAR_FILE,
	NAMZU_ROOT_VARIABLE,
} from '../common-layout-names.js'
import { expandPluginPaths } from '../common-layout/paths.js'
import { findCommonLayoutRoot, readCommonLayout } from '../common-layout/read.js'
import type { CommonLayoutRead, LayoutFinding } from '../common-layout/types.js'

const MANIFEST = `${COMMON_MANIFEST_DIR}/plugin.json`

/** A folder named `name` under a fresh temporary parent, holding `files`. */
function folder(name: string, files: Record<string, string | object>): string {
	const parent = mkdtempSync(join(tmpdir(), 'namzu-layout-'))
	const root = join(parent, name)
	mkdirSync(root, { recursive: true })
	// Servers need a manifest; the tests of the servers are not about that rule.
	const given =
		COMMON_MCP_FILE in files && !(MANIFEST in files) ? { ...files, [MANIFEST]: { name } } : files
	for (const [path, content] of Object.entries(given)) {
		const full = join(root, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
	}
	return root
}

const skill = (name: string, description = 'Does the thing.') =>
	`---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`

const ENV = { TOKEN: 'secret-value' }

function find(read: CommonLayoutRead, code: string, field?: string): LayoutFinding | undefined {
	return read.findings.find((f) => f.code === code && (field === undefined || f.field === field))
}

describe('detection and sources', () => {
	it('reads a folder with only the conventional folders, named after the folder', async () => {
		const root = folder('plain-tools', {
			'skills/alpha/SKILL.md': skill('alpha'),
		})
		const read = await readCommonLayout(root, { environment: ENV })
		expect(read.source).toBe('conventional')
		expect(read.refusal).toBeUndefined()
		expect(read.manifest).toMatchObject({
			name: 'plain-tools',
			skills: ['skills/alpha'],
			layout: 'common',
		})
		expect(read.manifest?.version).toMatch(/^0\.0\.0\+[0-9a-f]{8}$/)
		expect(read.manifest?.description).toBe('(no description)')
	})

	it('reads a root SKILL.md as a one-skill plugin', async () => {
		const root = folder('solo', { 'SKILL.md': skill('solo') })
		const read = await readCommonLayout(root)
		expect(read.source).toBe('single-skill')
		expect(read.manifest?.skills).toEqual(['.'])
		expect(read.manifest?.name).toBe('solo')
	})

	it('reads the common manifest, and says nothing of a Namzu plugin.json', async () => {
		const root = folder('ledger', {
			[MANIFEST]: { name: 'ledger', version: '1.2.0', description: 'Books.' },
			'skills/reconcile/SKILL.md': skill('reconcile'),
		})
		const read = await readCommonLayout(root)
		expect(read.source).toBe('manifest')
		expect(read.manifest).toMatchObject({
			name: 'ledger',
			version: '1.2.0',
			layout: 'common',
		})

		const both = folder('both', {
			'plugin.json': { name: 'both', version: '1.0.0', description: 'x' },
			[MANIFEST]: { name: 'other' },
		})
		const second = await readCommonLayout(both)
		expect(second.source).toBe('namzu')
		expect(second.manifest).toBeUndefined()
		expect(find(second, 'manifest-both')?.level).toBe('ignored')
	})

	it('refuses a folder that holds nothing it reads', async () => {
		const read = await readCommonLayout(folder('empty', { 'notes.txt': 'hi' }))
		expect(read.source).toBe('none')
		expect(read.refusal?.code).toBe('not-a-plugin')
	})

	it('refuses a root that is not a folder, a manifest that is not JSON, and one over the size cap', async () => {
		const parent = mkdtempSync(join(tmpdir(), 'namzu-layout-'))
		writeFileSync(join(parent, 'file'), 'x')
		expect((await readCommonLayout(join(parent, 'file'))).refusal?.code).toBe('root-not-directory')
		const bad = folder('bad', { [MANIFEST]: '{ nope' })
		expect((await readCommonLayout(bad)).refusal?.code).toBe('manifest-invalid')
		const big = folder('big', {
			[MANIFEST]: `{"name":"big","pad":"${'x'.repeat(300 * 1024)}"}`,
		})
		const read = await readCommonLayout(big)
		expect(read.refusal?.code).toBe('manifest-invalid')
		expect(read.refusal?.message).toContain('larger than 256 KiB')
	})

	it('refuses a manifest folder that is a link', async () => {
		const root = folder('linked', { 'real/plugin.json': { name: 'linked' } })
		symlinkSync(join(root, 'real'), join(root, COMMON_MANIFEST_DIR), 'dir')
		const read = await readCommonLayout(root)
		expect(read.refusal?.code).toBe('path-escapes')
	})
})

describe('manifest fields', () => {
	it('keeps name, version, description and flattens an author object', async () => {
		const root = folder('fields', {
			[MANIFEST]: {
				name: 'fields',
				version: '2.0.0',
				description: 'Real.',
				author: { name: 'Ada', email: 'ada@example.com' },
				displayName: 'Fields',
				homepage: 'https://example.com',
				repository: 'https://example.com/r',
				license: 'MIT',
				keywords: ['a'],
				metadata: { x: 1 },
				$schema: 'https://example.com/s.json',
				icon: 'i.png',
				defaultEnabled: false,
				connectors: ['c'],
				personas: ['p'],
				mystery: true,
			},
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		expect(read.manifest).toMatchObject({
			name: 'fields',
			version: '2.0.0',
			description: 'Real.',
			author: 'Ada <ada@example.com>',
		})
		expect(read.manifest).not.toHaveProperty('connectors')
		for (const field of [
			'displayName',
			'homepage',
			'repository',
			'license',
			'keywords',
			'metadata',
			'$schema',
			'icon',
			'connectors',
			'personas',
		]) {
			expect(find(read, 'manifest-metadata', field)?.level).toBe('ignored')
		}
		expect(find(read, 'manifest-metadata', 'defaultEnabled')?.message).toContain('recorded yes')
		expect(find(read, 'manifest-unknown-key', 'mystery')?.level).toBe('ignored')
	})

	it('keeps a string author, and takes the description from the README when absent', async () => {
		const root = folder('readme', {
			[MANIFEST]: { name: 'readme', author: 'Grace' },
			'README.md': '# Title\n\nFirst real line.\nSecond.\n',
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root, { version: 'abc123def456' })
		expect(read.manifest).toMatchObject({
			author: 'Grace',
			description: 'First real line.',
			version: 'abc123def456',
		})
	})

	it('refuses a name that is not lowercase words joined by dashes', async () => {
		const read = await readCommonLayout(
			folder('x', {
				[MANIFEST]: { name: 'Bad_Name' },
				'skills/a/SKILL.md': skill('a'),
			}),
		)
		expect(read.refusal).toMatchObject({
			code: 'name-invalid',
			message: 'name must be lowercase words joined by dashes.',
		})
	})

	it('honours engines.namzu and platforms, and ignores other engines', async () => {
		const root = folder('eng', {
			[MANIFEST]: {
				name: 'eng',
				engines: { namzu: '>=1.0.0', other: '>=9' },
				platforms: ['linux'],
			},
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.engines).toEqual({ namzu: '>=1.0.0' })
		expect(read.manifest?.platforms).toEqual(['linux'])
	})

	it('refuses dependencies that are not installed, and accepts ones that are', async () => {
		const files = {
			[MANIFEST]: {
				name: 'dep',
				dependencies: ['base', { name: 'other@market' }],
			},
			'skills/a/SKILL.md': skill('a'),
		}
		const unmet = await readCommonLayout(folder('dep', files))
		expect(unmet.refusal?.code).toBe('dependency-unmet')
		expect(unmet.refusal?.message).toContain('It needs base, which is not installed')
		const met = await readCommonLayout(folder('dep', files), {
			installedIds: new Set(['base@market', 'other@market']),
		})
		expect(met.refusal).toBeUndefined()
	})

	it('marks what Namzu has no place for, loudly for settings and binaries', async () => {
		const root = folder('misc', {
			[MANIFEST]: {
				name: 'misc',
				outputStyles: ['a', 'b'],
				themes: ['t'],
				workflows: ['w'],
				monitors: [{ x: 1 }],
				channels: [],
				lspServers: { ts: {} },
				binaries: { tool: {} },
				settings: { a: 1 },
				types: './t.d.ts',
				network: { hosts: ['example.com'] },
				experimental: { evals: 'evals' },
				userConfig: { token: { type: 'string' } },
			},
			'bin/run': '#!/bin/sh',
			'themes/dark.json': '{}',
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		for (const field of [
			'outputStyles',
			'themes',
			'workflows',
			'monitors',
			'lspServers',
			'binaries',
			'settings',
			'types',
			'network',
			'experimental',
		]) {
			expect(find(read, 'component-unsupported', field)?.level).toBe('notUsed')
		}
		expect(find(read, 'component-unsupported', 'outputStyles')?.message).toContain('(2)')
		expect(find(read, 'component-unsupported', 'settings')?.message).toContain(
			'asks to change your settings',
		)
		expect(find(read, 'component-unsupported', 'binaries')?.message).toContain(
			'put on this computer',
		)
		expect(find(read, 'component-unsupported', 'network')?.message).toContain('example.com')
		expect(find(read, 'component-unsupported', 'bin')?.level).toBe('notUsed')
		expect(find(read, 'user-config-unsupported')?.level).toBe('notUsed')
	})

	it('refuses a plugin with nothing usable left, naming what it has', async () => {
		const read = await readCommonLayout(
			folder('themed', { [MANIFEST]: { name: 'themed', themes: ['t'] } }),
		)
		expect(read.refusal).toMatchObject({ code: 'nothing-used' })
		expect(read.refusal?.message).toBe('Nothing in themed is used by Namzu (it only has: themes).')
	})
})

describe('skills', () => {
	it('adds declared folders to the auto-scanned skills/ and drops duplicates', async () => {
		const root = folder('sk', {
			[MANIFEST]: { name: 'sk', skills: ['./extra', 'skills/a'] },
			'skills/a/SKILL.md': skill('a'),
			'skills/b/SKILL.md': skill('b'),
			'extra/SKILL.md': skill('extra'),
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.skills).toEqual(['extra', 'skills/a', 'skills/b'])
	})

	it('takes "." as one skill only when SKILL.md is there', async () => {
		const withFile = folder('dot', {
			[MANIFEST]: { name: 'dot', skills: ['.'] },
			'SKILL.md': skill('dot'),
		})
		expect((await readCommonLayout(withFile)).manifest?.skills).toEqual(['.'])
		const without = folder('dot', {
			[MANIFEST]: { name: 'dot', skills: ['.'] },
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(without)
		expect(find(read, 'skill-no-file')?.level).toBe('ignored')
		expect(read.manifest?.skills).toEqual(['skills/a'])
	})

	it('ignores a subfolder without SKILL.md, hidden folders and node_modules', async () => {
		const root = folder('ig', {
			'skills/a/SKILL.md': skill('a'),
			'skills/empty/readme.txt': 'x',
			'skills/.hidden/SKILL.md': skill('hidden'),
			'skills/node_modules/SKILL.md': skill('node_modules'),
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.skills).toEqual(['skills/a'])
		expect(find(read, 'skill-no-file')?.path).toBe('skills/empty')
	})

	it('refuses one invalid skill and loads the rest', async () => {
		const root = folder('inv', {
			'skills/good/SKILL.md': skill('good'),
			'skills/bad/SKILL.md': '---\nname: bad\n---\nno description\n',
		})
		const read = await readCommonLayout(root)
		expect(read.refusal).toBeUndefined()
		expect(read.manifest?.skills).toEqual(['skills/good'])
		const finding = find(read, 'skill-invalid')
		expect(finding).toMatchObject({
			level: 'refused',
			path: 'skills/bad/SKILL.md',
		})
		expect(finding?.message).toContain('description')
	})

	it('does not follow a linked skill folder or a linked SKILL.md', async () => {
		const root = folder('links', { 'skills/a/SKILL.md': skill('a') })
		const outside = folder('outside', { 'SKILL.md': skill('outside') })
		symlinkSync(outside, join(root, 'skills/outside'), 'dir')
		mkdirSync(join(root, 'skills/b'))
		symlinkSync(join(outside, 'SKILL.md'), join(root, 'skills/b/SKILL.md'))
		const read = await readCommonLayout(root)
		expect(read.manifest?.skills).toEqual(['skills/a'])
		const links = read.findings.filter((f) => f.code === 'symlink')
		expect(links.map((f) => f.path).sort()).toEqual(['skills/b/SKILL.md', 'skills/outside'])
	})

	it('refuses the plugin when a declared path leaves the folder or goes through a link', async () => {
		const leaving = folder('esc', {
			[MANIFEST]: { name: 'esc', skills: ['../elsewhere'] },
		})
		expect((await readCommonLayout(leaving)).refusal?.code).toBe('path-escapes')
		const absolute = folder('abs', {
			[MANIFEST]: { name: 'abs', skills: ['/etc'] },
		})
		expect((await readCommonLayout(absolute)).refusal?.code).toBe('path-escapes')
		const through = folder('thr', {
			[MANIFEST]: { name: 'thr', skills: ['inner/a'] },
		})
		const outside = folder('outside', { 'a/SKILL.md': skill('a') })
		symlinkSync(outside, join(through, 'inner'), 'dir')
		expect((await readCommonLayout(through)).refusal?.code).toBe('path-escapes')
	})

	it('refuses more than 64 skills', async () => {
		const files: Record<string, string> = {}
		for (let i = 0; i < 65; i++)
			files[`skills/s${String(i).padStart(2, '0')}/SKILL.md`] = skill(
				`s${String(i).padStart(2, '0')}`,
			)
		const read = await readCommonLayout(folder('many', files))
		expect(read.refusal?.code).toBe('too-many-skills')
		const ok: Record<string, string> = {}
		for (let i = 0; i < 64; i++)
			ok[`skills/s${String(i).padStart(2, '0')}/SKILL.md`] = skill(`s${String(i).padStart(2, '0')}`)
		expect((await readCommonLayout(folder('many', ok))).manifest?.skills).toHaveLength(64)
	})
})

describe('commands and agents', () => {
	it('auto-scans commands/ and agents/ when the manifest names none', async () => {
		const root = folder('auto', {
			'commands/go.md': 'Go.',
			'agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\nPrompt.\n',
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.commands).toEqual(['commands'])
		expect(read.manifest?.agents).toEqual(['agents'])
	})

	it('supports single files, and a named list shadows the folder with a finding', async () => {
		const root = folder('single', {
			[MANIFEST]: {
				name: 'single',
				commands: ['./commands/one.md'],
				agents: 'agents/a.md',
			},
			'commands/one.md': 'One.',
			'commands/two.md': 'Two.',
			'agents/a.md': '---\nname: a\ndescription: A.\ncolor: red\n---\nP.\n',
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.commands).toEqual(['commands/one.md'])
		expect(read.manifest?.agents).toEqual(['agents/a.md'])
		expect(find(read, 'folder-shadowed-by-manifest', 'commands')?.level).toBe('notUsed')
		const key = find(read, 'agent-key-ignored')
		expect(key).toMatchObject({ level: 'ignored', path: 'agents/a.md' })
		expect(key?.message).toContain('"color"')
	})

	it('takes the object-map form as paths and refuses inline text for that entry', async () => {
		const root = folder('map', {
			[MANIFEST]: {
				name: 'map',
				commands: {
					go: { source: './commands/go.md' },
					inline: { content: 'text' },
				},
			},
			'commands/go.md': 'Go.',
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.commands).toEqual(['commands/go.md'])
		expect(find(read, 'inline-text-unsupported')).toMatchObject({
			level: 'refused',
			message: 'commands.inline: inline text is not supported',
		})
	})

	it('reports a missing path, a non-markdown file and a link', async () => {
		const root = folder('odd', {
			[MANIFEST]: {
				name: 'odd',
				commands: ['commands/gone.md', 'commands/x.txt', 'commands/ok.md'],
			},
			'commands/x.txt': 'x',
			'commands/ok.md': 'ok',
		})
		const read = await readCommonLayout(root)
		expect(find(read, 'path-missing')?.level).toBe('refused')
		expect(find(read, 'file-not-markdown')?.level).toBe('ignored')
		expect(read.manifest?.commands).toEqual(['commands/ok.md'])
		const linked = folder('lk', {
			[MANIFEST]: { name: 'lk', agents: ['agents'] },
		})
		symlinkSync(folder('o', { 'a.md': 'x' }), join(linked, 'agents'), 'dir')
		expect((await readCommonLayout(linked)).refusal?.code).toBe('path-escapes')
	})
})

describe('hooks', () => {
	const hook = { type: 'command', command: '${NAMZU_PLUGIN_ROOT}/guard.sh' }

	it('reads hooks/hooks.json without it being listed, and a listed path', async () => {
		const root = folder('hk', {
			[MANIFEST]: { name: 'hk', hooks: './extra.json' },
			'hooks/hooks.json': {
				hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] },
			},
			'extra.json': { hooks: { Stop: [{ hooks: [hook] }] } },
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.hooks).toEqual(['extra.json', 'hooks/hooks.json'])
		expect(find(read, 'hooks-used')?.level).toBe('used')
	})

	it('reads inline events, a list mixing paths and events', async () => {
		const root = folder('inl', {
			[MANIFEST]: {
				name: 'inl',
				hooks: ['./h.json', { PostToolUse: [{ hooks: [hook] }] }],
			},
			'h.json': { PreToolUse: [{ hooks: [hook] }] },
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.hooks).toEqual(['h.json'])
		expect(Object.keys(read.manifest?.hookEntries ?? {})).toEqual(['PostToolUse'])
	})

	it('reads a modules list in hooks/hooks.json, refusing the module that is not there, and ignores an unknown event', async () => {
		const root = folder('mod', {
			[MANIFEST]: { name: 'mod' },
			'hooks/hooks.json': {
				modules: ['./m.js'],
				hooks: {
					PreToolUse: [{ hooks: [hook] }],
					Mystery: [{ hooks: [hook] }],
				},
			},
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		expect(read.refusal).toBeUndefined()
		expect(find(read, 'hooks-module-scan-refused')).toMatchObject({
			level: 'refused',
			path: 'hooks/m.js',
		})
		expect(find(read, 'hooks-modules-refused')).toBeUndefined()
		expect(find(read, 'hook-event-unknown')?.message).toContain('"Mystery"')
	})

	it('refuses a hooks path that is program code, from the manifest and from a sidecar', async () => {
		const root = folder('evil', {
			[MANIFEST]: { name: 'evil', description: 'd', hooks: './hooks/evil.js' },
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		expect(read.manifest?.hooks).toBeUndefined()
		expect(find(read, 'hooks-module-refused')).toMatchObject({
			level: 'refused',
			path: 'hooks/evil.js',
		})
		expect(find(read, 'hooks-used')).toBeUndefined()
		const viaSidecar = folder('evil2', {
			[MANIFEST]: { name: 'evil2' },
			[ENTRY_SIDECAR_FILE]: { strict: false, hooks: ['./x.mjs'] },
			'skills/a/SKILL.md': skill('a'),
		})
		const sidecar = await readCommonLayout(viaSidecar, { entrySidecar: true })
		expect(sidecar.manifest?.hooks).toBeUndefined()
		expect(find(sidecar, 'hooks-module-refused')?.path).toBe('x.mjs')
	})

	it('refuses hooks or servers with no manifest', async () => {
		const root = folder('bare', {
			'hooks/hooks.json': { hooks: { Stop: [{ hooks: [hook] }] } },
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		expect(read.refusal?.code).toBe('manifest-required')
	})

	it('keeps a root skill whose name is not its folder name', async () => {
		const root = folder('1.0.0', {
			[MANIFEST]: { name: 'one', skills: './' },
			'SKILL.md': skill('solo'),
		})
		const read = await readCommonLayout(root)
		expect(read.refusal).toBeUndefined()
		expect(read.manifest?.skills).toEqual(['.'])
	})

	it('refuses an invalid or missing hooks file for that file, and a path that leaves the folder for the plugin', async () => {
		const root = folder('bad', {
			[MANIFEST]: { name: 'bad', hooks: ['./nope.json', './broken.json'] },
			'broken.json': '{ x',
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root)
		expect(find(read, 'hooks-file-missing')?.level).toBe('refused')
		expect(find(read, 'hooks-file-invalid')?.level).toBe('refused')
		const leaving = folder('esc', {
			[MANIFEST]: { name: 'esc', hooks: '../x.json' },
		})
		expect((await readCommonLayout(leaving)).refusal?.code).toBe('path-escapes')
	})
})

describe('servers', () => {
	const options = {
		environment: ENV,
		paths: () => ({ data: '/data/ledger', project: '/proj' }),
	}

	it('reads the keyed form of the root servers file and starts local servers as before', async () => {
		const root = folder('srv', {
			[COMMON_MCP_FILE]: {
				mcpServers: {
					db: {
						command: 'node',
						args: [`\${${COMMON_ROOT_VARIABLE}}/server.js`, `\${${COMMON_DATA_VARIABLE}}`],
						env: { TOKEN: '${TOKEN}', PROJ: `\${${COMMON_PROJECT_VARIABLE}}` },
						cwd: '/x',
						timeout: 5,
					},
				},
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.manifest?.mcpServers).toEqual([
			{
				name: 'db',
				command: 'node',
				args: [`${root}/server.js`, '/data/ledger'],
				env: { TOKEN: 'secret-value', PROJ: '/proj' },
			},
		])
		expect(find(read, 'mcp-key-ignored', 'mcpServers.db.cwd')?.level).toBe('ignored')
		expect(find(read, 'mcp-key-ignored', 'mcpServers.db.timeout')?.level).toBe('ignored')
		expect(find(read, 'mcp-server-local')?.level).toBe('used')
	})

	it('reads the flat form, the manifest path form, an inline map and both spellings of the root name', async () => {
		const root = folder('flat', {
			[COMMON_MCP_FILE]: { one: { command: `\${${NAMZU_ROOT_VARIABLE}}/one` } },
			'more.json': { mcpServers: { two: { command: 'two', type: 'stdio' } } },
			[MANIFEST]: {
				name: 'flat',
				mcpServers: ['./more.json', { three: { command: 'three' } }, './bundle.mcpb'],
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.manifest?.mcpServers?.map((s) => [s.name, s.command])).toEqual([
			['two', 'two'],
			['three', 'three'],
			['one', `${root}/one`],
		])
		expect(find(read, 'mcp-bundle')?.level).toBe('ignored')
	})

	it('reads a remote server, parses it and reports it as not started', async () => {
		const root = folder('rem', {
			[COMMON_MCP_FILE]: {
				api: {
					type: 'http',
					url: 'https://mcp.example.com/x',
					headers: { Authorization: 'Bearer ${API_TOKEN}' },
				},
				stream: { type: 'sse', url: 'https://mcp.example.com/sse' },
				bare: { url: 'https://mcp.example.com/y' },
				alias: { type: 'streamable-http', url: 'https://mcp.example.com/z' },
			},
		})
		const read = await readCommonLayout(root, {
			...options,
			environment: { ...ENV, API_TOKEN: 'x' },
		})
		expect(read.remoteServers.map((s) => [s.name, s.transport])).toEqual([
			['api', 'http'],
			['stream', 'sse'],
			['bare', 'http'],
			['alias', 'http'],
		])
		expect(read.remoteServers[0]?.headers).toEqual({
			Authorization: 'Bearer ${API_TOKEN}',
		})
		expect(read.manifest?.remoteMcpServers).toHaveLength(4)
		expect(read.manifest?.mcpServers).toBeUndefined()
		expect(find(read, 'mcp-server-remote', 'mcpServers.api')).toMatchObject({
			level: 'notUsed',
			message: expect.stringContaining('https://mcp.example.com'),
		})
	})

	it('marks a remote server whose header variable is unset or not a bare name as needing setup', async () => {
		const root = folder('hdr', {
			[COMMON_MCP_FILE]: {
				unset: {
					url: 'https://mcp.example.com/a',
					headers: { A: 'Bearer ${NOPE}' },
				},
				dflt: { url: 'https://mcp.example.com/b', headers: { A: '${X:-d}' } },
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.remoteServers).toHaveLength(0)
		expect(find(read, 'mcp-needs-setup', 'mcpServers.unset')?.message).toContain('NOPE is not set')
		expect(find(read, 'mcp-needs-setup', 'mcpServers.dflt')?.message).toContain('headers.A')
	})

	it('names which kind of server needs setup, and a plugin with only such a remote server still loads', async () => {
		const root = folder('onlyremote', {
			[COMMON_MCP_FILE]: {
				api: { url: 'https://mcp.example.com/a', headers: { A: 'Bearer ${NOPE}' } },
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.refusal).toBeUndefined()
		expect(find(read, 'mcp-needs-setup', 'mcpServers.api')?.server).toMatchObject({
			name: 'api',
			kind: 'remote',
			target: 'https://mcp.example.com/a',
		})
		const local = folder('onlylocal', {
			[COMMON_MCP_FILE]: { db: { command: 'x', env: { A: '${MISSING}' } }, ok: { command: 'y' } },
		})
		expect(
			find(await readCommonLayout(local, options), 'mcp-needs-setup', 'mcpServers.db')?.server,
		).toMatchObject({ name: 'db', kind: 'local', target: 'x' })
	})

	it('refuses an entry that names both forms, a bad address and an unknown type, and the plugin loads without them', async () => {
		const root = folder('ref', {
			[COMMON_MCP_FILE]: {
				both: { command: 'x', url: 'https://a.example.com' },
				ftp: { url: 'ftp://a.example.com' },
				cred: { url: 'https://user:pw@a.example.com' },
				junk: { url: 'not a url' },
				weird: { type: 'websocket', url: 'https://a.example.com' },
				weird2: { type: 'pipe', command: 'x' },
				ok: { command: 'fine' },
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.refusal).toBeUndefined()
		expect(read.manifest?.mcpServers?.map((s) => s.name)).toEqual(['ok'])
		for (const code of ['mcp-server-both', 'mcp-url-invalid', 'mcp-type-unsupported']) {
			expect(find(read, code)?.level).toBe('refused')
		}
	})

	it('carries a server that needs setup as written, so a host can still show it', async () => {
		const root = folder('asw', {
			[COMMON_MCP_FILE]: {
				rem: {
					url: 'https://mcp.example.com/${TOK}',
					headers: { A: 'Bearer ${TOK2}' },
				},
				loc: { command: 'x', args: ['${TOKEN}'], env: { A: '${MISSING}' } },
			},
		})
		const read = await readCommonLayout(root, { environment: ENV })
		expect(find(read, 'mcp-needs-setup', 'mcpServers.rem')?.server).toEqual({
			name: 'rem',
			kind: 'remote',
			target: 'https://mcp.example.com/${TOK}',
			transport: 'http',
			values: { A: 'Bearer ${TOK2}' },
		})
		expect(find(read, 'mcp-needs-setup', 'mcpServers.loc')?.server).toMatchObject({
			kind: 'local',
			target: 'x',
			args: ['${TOKEN}'],
			values: { A: '${MISSING}' },
		})
	})

	it('marks a server that needs setup and does not start it', async () => {
		const root = folder('need', {
			[COMMON_MCP_FILE]: {
				unset: { command: 'x', env: { A: '${MISSING}' } },
				inargs: { command: 'x', args: ['${TOKEN}'] },
				incmd: { command: '${TOKEN}' },
				inurl: { url: 'https://a.example.com/${TOKEN}' },
				opt: { command: 'x', env: { A: '${user_config.key}' } },
				nodata: { command: 'x', args: [`\${${COMMON_DATA_VARIABLE}}`] },
				ok: { command: 'ok' },
			},
		})
		const read = await readCommonLayout(root, { environment: ENV })
		expect(read.manifest?.mcpServers?.map((s) => s.name)).toEqual(['ok'])
		const messages = read.findings.filter((f) => f.code === 'mcp-needs-setup').map((f) => f.message)
		expect(messages).toHaveLength(6)
		expect(messages.find((m) => m.startsWith('unset'))).toContain('MISSING is not set')
		expect(messages.find((m) => m.startsWith('inargs'))).toContain('not expanded in args')
		expect(messages.find((m) => m.startsWith('inurl'))).toContain('not expanded in url')
		expect(messages.find((m) => m.startsWith('opt'))).toContain('saved option')
		expect(messages.find((m) => m.startsWith('nodata'))).toContain('has no folder here')
	})

	it('refuses a relative command with .. for that server, allows a bare name, a file inside and an absolute path', async () => {
		const root = folder('cmd', {
			[COMMON_MCP_FILE]: {
				up: { command: '../bin/x' },
				bare: { command: 'node' },
				inside: { command: './bin/x' },
				abs: { command: '/usr/bin/env' },
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.manifest?.mcpServers?.map((s) => s.name)).toEqual(['bare', 'inside', 'abs'])
		expect(find(read, 'mcp-command-escapes')?.level).toBe('refused')
	})

	it('reports other $-forms, backticks and %NAME% and leaves them as written', async () => {
		const root = folder('odd', {
			[COMMON_MCP_FILE]: {
				s: { command: 'sh', args: ['$HOME', '`id`', '%TEMP%'] },
			},
		})
		const read = await readCommonLayout(root, options)
		expect(read.manifest?.mcpServers?.[0]?.args).toEqual(['$HOME', '`id`', '%TEMP%'])
		expect(read.findings.filter((f) => f.code === 'mcp-text-left-as-is')).toHaveLength(3)
	})

	it('ignores an entry with neither form, a duplicate name and an empty value; refuses an unusable name', async () => {
		const root = folder('misc', {
			[COMMON_MCP_FILE]: {
				empty: {},
				str: 'x',
				'bad name!': { command: 'x' },
				ok: { command: 'x' },
			},
			'more.json': { ok: { command: 'second' } },
			[MANIFEST]: { name: 'misc', mcpServers: './more.json' },
		})
		const read = await readCommonLayout(root, options)
		expect(read.manifest?.mcpServers).toEqual([{ name: 'ok', command: 'second' }])
		expect(find(read, 'mcp-server-duplicate')?.level).toBe('ignored')
		expect(read.findings.filter((f) => f.code === 'mcp-server-empty')).toHaveLength(2)
		expect(find(read, 'mcp-name-invalid')?.level).toBe('refused')
	})

	it('refuses a plugin with more than 16 servers', async () => {
		const servers = (count: number) =>
			Object.fromEntries(Array.from({ length: count }, (_, i) => [`s${i}`, { command: 'x' }]))
		const many = await readCommonLayout(folder('many', { [COMMON_MCP_FILE]: servers(17) }), options)
		expect(many.refusal?.code).toBe('too-many-servers')
		const ok = await readCommonLayout(folder('many', { [COMMON_MCP_FILE]: servers(16) }), options)
		expect(ok.manifest?.mcpServers).toHaveLength(16)
	})

	it('refuses a servers file that is invalid or listed and missing, for that file', async () => {
		const root = folder('files', {
			[COMMON_MCP_FILE]: '{ x',
			[MANIFEST]: { name: 'files', mcpServers: './gone.json' },
			'skills/a/SKILL.md': skill('a'),
		})
		const read = await readCommonLayout(root, options)
		expect(find(read, 'mcp-file-invalid')?.level).toBe('refused')
		expect(find(read, 'mcp-file-missing')?.level).toBe('refused')
		expect(read.refusal).toBeUndefined()
	})
})

describe('the marketplace-entry sidecar', () => {
	const sidecar = {
		name: 'entry-plugin',
		description: 'From the entry.',
		version: '3.1.0',
		strict: false,
		hooks: {
			PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }],
		},
		skills: ['./pick'],
		mysteryField: 1,
	}

	it('is read only when asked, and then supplies the manifest', async () => {
		const files = {
			[ENTRY_SIDECAR_FILE]: sidecar,
			'pick/SKILL.md': skill('pick'),
		}
		const read = await readCommonLayout(folder('entry-plugin', files), {
			entrySidecar: true,
		})
		expect(read.source).toBe('sidecar')
		expect(read.manifest).toMatchObject({
			name: 'entry-plugin',
			version: '3.1.0',
			description: 'From the entry.',
			skills: ['pick'],
		})
		expect(Object.keys(read.manifest?.hookEntries ?? {})).toEqual(['PreToolUse'])
	})

	it('is never read without the option: a folder holding only the sidecar is not a plugin', async () => {
		const read = await readCommonLayout(folder('entry-plugin', { [ENTRY_SIDECAR_FILE]: sidecar }))
		expect(read.source).toBe('none')
		expect(read.refusal?.code).toBe('not-a-plugin')
	})

	it('cannot inject components into a folder that has its own manifest unless the option is set', async () => {
		const files = {
			[MANIFEST]: { name: 'own', description: 'Own.' },
			'skills/a/SKILL.md': skill('a'),
			[ENTRY_SIDECAR_FILE]: { ...sidecar, name: 'own' },
		}
		const without = await readCommonLayout(folder('own', files))
		expect(without.manifest?.hookEntries).toBeUndefined()
		expect(without.manifest?.version).toMatch(/^0\.0\.0\+/)
		const withIt = await readCommonLayout(folder('own', files), {
			entrySidecar: true,
		})
		expect(Object.keys(withIt.manifest?.hookEntries ?? {})).toEqual(['PreToolUse'])
		expect(withIt.manifest?.version).toBe('3.1.0')
	})

	it('lets the plugin manifest decide when the entry does not say strict: false', async () => {
		const files = {
			[MANIFEST]: { name: 'own', version: '1.0.0' },
			'skills/a/SKILL.md': skill('a'),
			[ENTRY_SIDECAR_FILE]: { ...sidecar, strict: undefined, name: 'own' },
		}
		const read = await readCommonLayout(folder('own', files), {
			entrySidecar: true,
		})
		expect(read.manifest?.hookEntries).toBeUndefined()
		expect(read.manifest?.version).toBe('1.0.0')
		expect(read.manifest?.description).toBe('From the entry.')
		expect(find(read, 'entry-inline-ignored', 'hooks')?.level).toBe('ignored')
	})

	it('does not follow a linked sidecar and refuses one that is not JSON', async () => {
		const linked = folder('lk', { 'skills/a/SKILL.md': skill('a') })
		const outside = folder('outside', { f: sidecar })
		symlinkSync(join(outside, 'f'), join(linked, ENTRY_SIDECAR_FILE))
		const read = await readCommonLayout(linked, { entrySidecar: true })
		expect(find(read, 'symlink')?.path).toBe(ENTRY_SIDECAR_FILE)
		expect(read.manifest?.hookEntries).toBeUndefined()
		const bad = await readCommonLayout(folder('b', { [ENTRY_SIDECAR_FILE]: '{ x' }), {
			entrySidecar: true,
		})
		expect(bad.refusal?.code).toBe('manifest-invalid')
	})
})

describe('archive roots', () => {
	it('descends into one wrapping folder that holds a recognised component', async () => {
		const parent = folder('unpacked', {
			'wrapped/skills/a/SKILL.md': skill('a'),
			'__MACOSX/x': 'junk',
			'.DS_Store': 'x',
		})
		// Two entries at the top (the wrapper and junk): the junk is ignored.
		expect(await findCommonLayoutRoot(parent)).toBe(join(parent, 'wrapped'))
	})

	it('stays put when the folder already holds a component, or the wrapper holds nothing recognised', async () => {
		const direct = folder('direct', { 'skills/a/SKILL.md': skill('a') })
		expect(await findCommonLayoutRoot(direct)).toBe(direct)
		const unrelated = folder('un', { 'docs/readme.txt': 'x' })
		expect(await findCommonLayoutRoot(unrelated)).toBe(unrelated)
		const manifestWrapped = folder('mw', {
			[`inner/${MANIFEST}`]: { name: 'inner' },
		})
		expect(await findCommonLayoutRoot(manifestWrapped)).toBe(join(manifestWrapped, 'inner'))
	})
})

describe('expandPluginPaths', () => {
	const values = { root: '/p/root', data: '/p/data', project: '/p/proj' }

	it('replaces exactly the six names', () => {
		const text = ['ROOT', 'DATA', 'PROJECT_DIR']
		expect(expandPluginPaths(`\${${COMMON_ROOT_VARIABLE}}/a`, values).text).toBe('/p/root/a')
		expect(expandPluginPaths(`\${${NAMZU_ROOT_VARIABLE}}/a`, values).text).toBe('/p/root/a')
		expect(
			expandPluginPaths(`\${${COMMON_DATA_VARIABLE}}|\${NAMZU_PLUGIN_DATA}`, values).text,
		).toBe('/p/data|/p/data')
		expect(
			expandPluginPaths(`\${${COMMON_PROJECT_VARIABLE}}|\${NAMZU_PROJECT_DIR}`, values).text,
		).toBe('/p/proj|/p/proj')
		expect(text).toHaveLength(3)
	})

	it('leaves other forms untouched and reports a name with no folder', () => {
		const out = expandPluginPaths('${OTHER} $HOME ${NAMZU_PLUGIN_ROOT:-x} ${NAMZU_PLUGIN_DATA}', {
			root: '/r',
		})
		expect(out.text).toBe('${OTHER} $HOME ${NAMZU_PLUGIN_ROOT:-x} ${NAMZU_PLUGIN_DATA}')
		expect(out.unresolved).toEqual(['NAMZU_PLUGIN_DATA'])
	})

	it('refuses a folder that is not absolute or holds a NUL', () => {
		expect(() => expandPluginPaths('${NAMZU_PLUGIN_ROOT}', { root: 'relative' })).toThrow(
			/absolute/,
		)
		expect(() => expandPluginPaths('${NAMZU_PLUGIN_ROOT}', { root: '/a\0b' })).toThrow(/NUL/)
	})
})
