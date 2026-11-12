/**
 * The check and the loader agree: for each fixture, the parts the loader
 * accepts are exactly the parts `validatePluginFolder` reports no error for.
 *
 * The loader side calls the real loading functions, each on the part it
 * loads: `loadPluginManifest`, `resolveWithinReal` and `loadSkill` into a real
 * `SkillRegistry`, `discoverUserCommands` and `discoverAgentDefinitions` on the
 * folders `resolvePluginFileDirs` admits. Two things are out of its reach by
 * design, and the fixtures that would expose them are left out below: a
 * tool or hook module is accepted by the loader when it imports and exports
 * the right array, which cannot be known without running it, so for those the
 * oracle is the loader's path rule; and a manifest larger than the 4 MiB the
 * check reads is not read here at all.
 */

import { readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
	PluginLifecycleManager,
	PluginMCPServerConfigSchema,
	PluginRegistry,
	SkillRegistry,
	loadPluginManifest,
	loadSkill,
	parsePluginManifestText,
	resolveWithinReal,
} from '@namzu/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
	FIXTURE_CASES,
	type FixtureSet,
	createFixtureSet,
	goodPlugin,
} from '../../__fixtures__/plugin-folders.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { cliLogger } from '../../logging.js'
import { discoverUserCommands } from '../../user-commands/store.js'
import { discoverAgentDefinitions } from '../subagents/definitions.js'
import { resolvePluginFileDirs } from './files.js'
import { validatePluginFolder } from './validate.js'

let set: FixtureSet

beforeAll(() => {
	set = createFixtureSet()
})
afterAll(() => removeTempDir(set.base))

/** What the loader accepts, as `<kind>:<name>`. */
async function loaderAccepts(dir: string): Promise<Set<string>> {
	const accepted = new Set<string>()
	const refused = new Set<string>()
	let manifestOk = true
	try {
		await loadPluginManifest(dir, { skillsSupported: true })
		accepted.add('manifest')
	} catch {
		manifestOk = false
	}
	let manifest: ReturnType<typeof parsePluginManifestText>
	try {
		manifest = parsePluginManifestText(readFileSync(join(dir, 'plugin.json'), 'utf8'))
	} catch {
		return accepted
	}
	void manifestOk

	for (const [kind, list] of [
		['tool', manifest.tools],
		['hook', manifest.hooks],
	] as const) {
		for (const rel of list ?? []) {
			try {
				const abs = await resolveWithinReal(dir, rel)
				if ((await stat(abs)).isFile()) accepted.add(`${kind}:${rel}`)
			} catch {
				// refused: not a file inside the folder
			}
		}
	}

	const registry = new SkillRegistry()
	for (const rel of manifest.skills ?? []) {
		const id = `skill:${rel}`
		try {
			const abs = await resolveWithinReal(dir, rel)
			const { skill } = await loadSkill(abs, 'metadata')
			registry.add(`${manifest.name}__${skill.metadata.name}`, skill)
			accepted.add(id)
		} catch {
			refused.add(id)
		}
	}
	for (const id of refused) accepted.delete(id)

	for (const server of manifest.mcpServers ?? []) {
		if (PluginMCPServerConfigSchema.safeParse(server).success) {
			accepted.add(`mcp-server:${server.name}`)
		}
	}

	const home = join(set.base, 'home')
	const cwd = join(set.base, 'cwd')
	const commandDirs = resolvePluginFileDirs(manifest.name, dir, manifest.commands).dirs
	for (const command of discoverUserCommands({ home, cwd, pluginCommandDirs: commandDirs })) {
		if (command.source === 'plugin' && command.problem === undefined) {
			accepted.add(`command:${command.name}`)
		}
	}
	const agentDirs = resolvePluginFileDirs(manifest.name, dir, manifest.agents).dirs
	const agents = await discoverAgentDefinitions({ cwd, home, pluginAgentDirs: agentDirs })
	for (const agent of agents.definitions) accepted.add(`agent:${agent.name}`)
	return accepted
}

/** What the check reports no error for; a folder's own entry is not a part. */
async function checkAccepts(dir: string): Promise<Set<string>> {
	const report = await validatePluginFolder(dir)
	const ids = report.parts
		.filter((part) => part.status !== 'error')
		.filter(
			(part) => !((part.kind === 'command' || part.kind === 'agent') && part.name.includes(':')),
		)
		.map((part) => (part.kind === 'manifest' ? 'manifest' : `${part.kind}:${part.name}`))
	return new Set(ids)
}

// A module's contents and an over-size manifest are the two places the check
// cannot reproduce the loader; see the header.
const NOT_COMPARABLE = new Set(['tool-binary', 'tool-huge', 'manifest-huge'])

describe('the loader and the check agree on which parts are accepted', () => {
	for (const fixture of FIXTURE_CASES) {
		if (NOT_COMPARABLE.has(fixture.name)) continue
		it(fixture.name, async () => {
			const dir = set.plugin(`agree-${fixture.name}`, fixture.files(set))
			expect([...(await checkAccepts(dir))].sort()).toEqual([...(await loaderAccepts(dir))].sort())
		})
	}

	it('good plugin: every part the loader takes is a part with no error', async () => {
		const dir = goodPlugin(set, 'agree-good')
		const accepted = await loaderAccepts(dir)
		expect([...accepted].sort()).toEqual(
			[
				'agent:ledger__reviewer',
				'command:ledger__audit',
				'hook:hooks/index.js',
				'manifest',
				'mcp-server:ledger-db',
				'skill:skills/reconcile',
				'tool:tools/index.js',
			].sort(),
		)
		expect([...(await checkAccepts(dir))].sort()).toEqual([...accepted].sort())
	})
})

describe('the whole loader on whole plugins', () => {
	async function enable(dir: string): Promise<'enabled' | string> {
		const skills = new SkillRegistry()
		const manager = new PluginLifecycleManager({
			pluginRegistry: new PluginRegistry(),
			skillRegistry: skills,
			scopeRoots: { project: dir, user: dir },
			log: cliLogger(),
		})
		try {
			const plugin = await manager.install(dir, 'user', { authorityRoot: dir })
			await manager.enable(plugin.id)
			await manager.uninstall(plugin.id)
			return 'enabled'
		} catch (error) {
			return error instanceof Error ? error.message : String(error)
		}
	}

	// A plugin with no MCP server so nothing is started; the other parts load for real.
	it('enables a plugin the check finds clean', async () => {
		const dir = set.plugin('whole-good', {
			'plugin.json': JSON.stringify({
				name: 'ledger',
				version: '1.0.0',
				description: 'd',
				tools: ['tools/index.js'],
				hooks: ['hooks/index.js'],
				skills: ['skills/reconcile'],
			}),
			'tools/index.js': 'export const tools = []\n',
			'hooks/index.js': 'export const hooks = []\n',
			'skills/reconcile/SKILL.md': readFileSync(set.outsideSkill, 'utf8'),
		})
		expect((await validatePluginFolder(dir)).status).toBe('clean')
		expect(await enable(dir)).toBe('enabled')
	})

	it('refuses a plugin the check finds an error in, for the same part', async () => {
		const dir = set.plugin('whole-bad', {
			'plugin.json': JSON.stringify({
				name: 'ledger',
				version: '1.0.0',
				description: 'd',
				skills: ['skills/reconcile'],
			}),
			'skills/reconcile/SKILL.md': '---\nname: other\ndescription: d\n---\nbody\n',
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems.map((p) => p.code)).toEqual(['skill-invalid'])
		const refusal = await enable(dir)
		expect(refusal).toMatch(/must match directory name/)
		expect(report.problems[0]?.message).toMatch(/must match directory name/)
	})

	it('refuses a manifest the check refuses, with the same reason', async () => {
		const dir = set.plugin('whole-manifest', {
			'plugin.json': JSON.stringify({
				name: 'ledger',
				version: '1.0.0',
				description: 'd',
				connectors: ['crm'],
			}),
		})
		const report = await validatePluginFolder(dir)
		expect(report.problems[0]?.code).toBe('manifest-incompatible')
		expect(await enable(dir)).toMatch(/cannot enable/)
		expect(report.problems[0]?.message).toMatch(/cannot enable/)
	})
})

describe('a declared folder', () => {
	it('is judged by the same rule the session applies', async () => {
		for (const name of ['commands-missing', 'commands-link-out', 'agents-missing']) {
			const fixture = FIXTURE_CASES.find((f) => f.name === name)
			if (!fixture) throw new Error(name)
			const dir = set.plugin(`folder-${name}`, fixture.files(set))
			const manifest = parsePluginManifestText(readFileSync(join(dir, 'plugin.json'), 'utf8'))
			const session = [
				...resolvePluginFileDirs(manifest.name, dir, manifest.commands).problems,
				...resolvePluginFileDirs(manifest.name, dir, manifest.agents).problems,
			]
			const report = await validatePluginFolder(dir)
			expect(session).toHaveLength(1)
			expect(report.problems.filter((p) => p.level === 'error')).toHaveLength(1)
			expect(relative(dir, dir)).toBe('')
		}
	})
})
