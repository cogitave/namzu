import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { discoverUserCommands, findUserCommand } from '../../user-commands/store.js'
import { discoverAgentDefinitions } from '../subagents/definitions.js'
import { readPluginFileSources } from './files.js'
import { createCliPluginRuntime } from './runtime.js'
import { validatePluginFolder } from './validate.js'

// The layout's own manifest folder, spelled once for the fixtures.
const MANIFEST = '.claude-plugin/plugin.json'

let root: string
let cwd: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-common-layout-'))
	cwd = join(root, 'project')
	home = join(root, 'home')
	mkdirSync(cwd, { recursive: true })
	mkdirSync(home, { recursive: true })
	vi.stubEnv('NAMZU_HOME', home)
})

afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(root)
})

function make(
	name: string,
	files: Record<string, string | object>,
	base = join(root, 'plugins'),
): string {
	const dir = join(base, name)
	for (const [path, content] of Object.entries(files)) {
		const full = join(dir, path)
		mkdirSync(dirname(full), { recursive: true })
		writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content))
	}
	return dir
}

const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\nBody.\n`
const agent = (name: string) =>
	`---\nname: ${name}\ndescription: Agent ${name}.\n---\nPROMPT at \${NAMZU_PLUGIN_ROOT}/x\n`

describe('a plugin in the common layout reaches the session', () => {
	it('loads through --plugin-dir with its skills, commands and agents, and says what is not used', async () => {
		const dir = make('ledger', {
			[MANIFEST]: { name: 'ledger', description: 'Books.', themes: ['t'], settings: { a: 1 } },
			'skills/reconcile/SKILL.md': skill('reconcile'),
			'commands/audit.md': 'Audit.',
			'agents/checker.md': agent('checker'),
		})
		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd)
		const [info] = runtime?.list() ?? []
		expect(info).toMatchObject({
			name: 'ledger',
			status: 'enabled',
			skills: ['ledger__reconcile'],
			commands: ['ledger__audit'],
			agents: ['ledger__checker'],
		})
		const lines = runtime?.takePluginHookWarnings() ?? []
		expect(lines.some((line) => line.includes('themes (1) is not used by Namzu'))).toBe(true)
		expect(lines.some((line) => line.includes('asks to change your settings'))).toBe(true)
		expect(runtime?.takePluginHookWarnings()).toEqual([])
		await runtime?.close()
	})

	it('loads a folder with only the conventional folders through --plugin-dir', async () => {
		const dir = make('just-commands', { 'commands/go.md': 'Go.' })
		const runtime = await createCliPluginRuntime({ launchDirs: [dir] }, cwd)
		expect(runtime?.list()[0]).toMatchObject({
			name: 'just-commands',
			commands: ['just-commands__go'],
		})
		await runtime?.close()
	})

	it('loads a hand-placed folder with the common manifest, and passes over a bare one', async () => {
		const placed = join(cwd, '.namzu', 'plugins')
		make(
			'placed',
			{ [MANIFEST]: { name: 'placed', description: 'Placed.' }, 'skills/a/SKILL.md': skill('a') },
			placed,
		)
		make('bare', { 'skills/b/SKILL.md': skill('b') }, placed)
		const runtime = await createCliPluginRuntime({ enabled: true, allowedScopes: ['project'] }, cwd)
		expect(runtime?.list().map((p) => p.name)).toEqual(['placed'])
		await runtime?.close()
	})
})

describe('a refused hand-placed folder', () => {
	it('is reported and the other plugins still load', async () => {
		const placed = join(cwd, '.namzu', 'plugins')
		make('good', { [MANIFEST]: { name: 'good' }, 'skills/a/SKILL.md': skill('a') }, placed)
		make('needy', { [MANIFEST]: { name: 'needy', dependencies: ['absent'] } }, placed)
		const runtime = await createCliPluginRuntime({ enabled: true, allowedScopes: ['project'] }, cwd)
		expect(runtime?.list().map((p) => p.name)).toEqual(['good'])
		expect(runtime?.takePluginHookWarnings().join('\n')).toContain('absent')
		await runtime?.close()
	})
})

describe('single-file commands and agents, root variables and the colon spelling', () => {
	it('contributes only the named file, with the plugin folder in its text', async () => {
		const dir = make('ledger', {
			[MANIFEST]: {
				name: 'ledger',
				description: 'Books.',
				commands: ['./commands/one.md'],
				agents: ['agents/a.md'],
			},
			'commands/one.md': 'Run ${CLAUDE_PLUGIN_ROOT}/go.sh $ARGUMENTS',
			'commands/two.md': 'Not named.',
			'agents/a.md': agent('a'),
			'agents/b.md': agent('b'),
		})
		const found = await readPluginFileSources({
			cwd,
			userRoot: home,
			config: { launchDirs: [dir] },
		})
		expect(found.problems).toEqual([])
		expect(found.commands).toHaveLength(1)
		const commands = discoverUserCommands({ home, cwd, pluginCommandDirs: found.commands })
		expect(commands.map((c) => c.name)).toEqual(['ledger__one'])
		expect(commands[0]?.template).toMatch(/^Run .*\/ledger\/go\.sh \$ARGUMENTS$/)
		expect(commands[0]?.template).not.toContain('CLAUDE_PLUGIN_ROOT')
		const agents = await discoverAgentDefinitions({ cwd, home, pluginAgentDirs: found.agents })
		expect(agents.definitions.map((d) => d.name)).toEqual(['ledger__a'])
		expect(agents.definitions[0]?.prompt).toMatch(/PROMPT at .*\/ledger\/x/)
		expect(agents.definitions[0]?.prompt).not.toContain('NAMZU_PLUGIN_ROOT')
	})

	it('accepts /<plugin>:<command> for a common-layout plugin and not for a Namzu one', async () => {
		const common = make('ledger', {
			[MANIFEST]: { name: 'ledger', description: 'Books.' },
			'commands/audit.md': 'Audit.',
		})
		const native = make('native', {
			'plugin.json': { name: 'native', version: '1.0.0', description: 'N', commands: ['commands'] },
			'commands/audit.md': 'Audit.',
		})
		const found = await readPluginFileSources({
			cwd,
			userRoot: home,
			config: { launchDirs: [common, native] },
		})
		const commands = discoverUserCommands({ home, cwd, pluginCommandDirs: found.commands })
		expect(findUserCommand(commands, 'ledger:audit')?.name).toBe('ledger__audit')
		expect(findUserCommand(commands, 'ledger__audit')?.name).toBe('ledger__audit')
		expect(findUserCommand(commands, 'native:audit')).toBeUndefined()
		expect(findUserCommand(commands, 'nothing:audit')).toBeUndefined()
		expect(findUserCommand(commands, ':audit')).toBeUndefined()
		expect(findUserCommand(commands, 'ledger:')).toBeUndefined()
	})

	it('refuses a named command file that is a link out of the plugin', async () => {
		const outside = make('outside', { 'x.md': 'x' })
		const dir = make('lk', {
			[MANIFEST]: { name: 'lk', description: 'L.', commands: ['commands/x.md'] },
			'skills/a/SKILL.md': skill('a'),
		})
		mkdirSync(join(dir, 'commands'))
		symlinkSync(join(outside, 'x.md'), join(dir, 'commands', 'x.md'))
		const found = await readPluginFileSources({
			cwd,
			userRoot: home,
			config: { launchDirs: [dir] },
		})
		expect(found.commands).toEqual([])
		expect(found.problems.join('\n')).toMatch(/lk/)
	})
})

describe('namzu plugin validate reads the layout', () => {
	it('checks a plugin in the common layout and lists its parts and what is not used', async () => {
		const dir = make('ledger', {
			[MANIFEST]: { name: 'ledger', version: '1.0.0', description: 'Books.', themes: ['t'] },
			'skills/reconcile/SKILL.md': skill('reconcile'),
			'commands/audit.md': 'Audit.',
			'.mcp.json': { db: { command: 'node' }, api: { url: 'https://mcp.example.com/' } },
		})
		const report = await validatePluginFolder(dir)
		expect(report.layout?.source).toBe('manifest')
		expect(report.plugin).toEqual({ name: 'ledger', version: '1.0.0' })
		expect(report.parts.map((p) => `${p.kind}:${p.name}`)).toEqual(
			expect.arrayContaining([
				'manifest:manifest',
				'skill:reconcile',
				'mcp-server:db',
				'mcp-server:api',
			]),
		)
		const codes = report.problems.map((p) => p.code).sort()
		expect(codes).toEqual(['component-unsupported', 'mcp-server-remote'])
		expect(report.status).toBe('warnings')
		expect(report.problems.every((p) => p.level === 'warning')).toBe(true)
		expect(report.layout?.findings.some((f) => f.level === 'used')).toBe(true)
	})

	it('does not warn about empty unused folders, and knows the data folder', async () => {
		const dir = make('quiet', {
			[MANIFEST]: { name: 'quiet' },
			'skills/a/SKILL.md': skill('a'),
			'.mcp.json': { db: { command: 'node', env: { A: '${NAMZU_PLUGIN_DATA}' } } },
		})
		mkdirSync(join(dir, 'output-styles'))
		mkdirSync(join(dir, 'monitors'))
		const report = await validatePluginFolder(dir)
		expect(report.problems).toEqual([])
	})

	it('is clean for a plugin with nothing to report', async () => {
		const dir = make('plain', { 'skills/a/SKILL.md': skill('a') })
		const report = await validatePluginFolder(dir)
		expect(report.status).toBe('clean')
		expect(report.layout?.source).toBe('conventional')
	})

	it('reports a refused plugin as an error, and one refused entry as a warning that drops it', async () => {
		const refused = await validatePluginFolder(
			make('themed', { [MANIFEST]: { name: 'themed', themes: ['t'] } }),
		)
		expect(refused.status).toBe('errors')
		expect(refused.problems.find((p) => p.level === 'error')).toMatchObject({
			code: 'nothing-used',
			part: 'manifest',
		})
		const entry = await validatePluginFolder(
			make('partial', {
				'skills/good/SKILL.md': skill('good'),
				'skills/bad/SKILL.md': '---\nname: bad\n---\nx\n',
			}),
		)
		expect(entry.status).toBe('warnings')
		expect(entry.problems).toHaveLength(1)
		expect(entry.problems[0]).toMatchObject({
			level: 'warning',
			code: 'skill-invalid',
			part: 'skill:bad',
		})
		expect(entry.problems[0]?.consequence).toContain('dropped')
	})

	it('refuses a plugin whose engines do not fit this runtime', async () => {
		const report = await validatePluginFolder(
			make('future', {
				[MANIFEST]: { name: 'future', engines: { namzu: '>=9999.0.0' } },
				'skills/a/SKILL.md': skill('a'),
			}),
		)
		expect(report.status).toBe('errors')
		expect(report.problems.map((p) => p.code)).toContain('manifest-incompatible')
	})

	it('warns that plugin.json is used when the common manifest is there too, and keeps the old checks', async () => {
		const dir = make('both', {
			'plugin.json': { name: 'both', version: '1.0.0', description: 'B' },
			[MANIFEST]: { name: 'other' },
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems.map((p) => p.code)).toContain('manifest-both')
		expect(report.layout).toBeUndefined()
		expect(report.plugin.name).toBe('both')
	})

	it('still says a folder with nothing in it has no manifest', async () => {
		const report = await validatePluginFolder(make('empty', { 'notes.txt': 'x' }))
		expect(report.problems.map((p) => p.code)).toEqual(['manifest-missing'])
	})
})
