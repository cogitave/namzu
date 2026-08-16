import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { assembleSystemPrompt } from '../../persona/assembler.js'
import { ToolRegistry } from '../../registry/index.js'
import { PluginRegistry } from '../../registry/plugin/index.js'
import { SkillRegistry } from '../../skills/registry.js'
import type { PluginId } from '../../types/ids/index.js'
import type { PluginDefinition, PluginManifest } from '../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../utils/log/create-logger.js'
import { PluginLifecycleManager } from '../lifecycle.js'
import { assertEnableable } from '../loader.js'

/**
 * A plugin's declared skills, actually loading.
 *
 * The manifest schema validated `skills` with a per-plugin cap and the
 * runtime then refused the whole plugin for declaring any — so a plugin
 * shipping four tools and one skill validated clean, installed clean, and
 * contributed nothing. The refusal was correct while there was no path into
 * `SkillRegistry`; this is the path.
 *
 * Process-level because it reads real SKILL.md files off disk, which is
 * where the manifest points and where a stubbed loader would prove nothing.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function pluginDir(
	manifest: Partial<PluginManifest> & { name: string },
	skills: { dir: string; name: string; description: string }[],
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-plugin-'))
	dirs.push(root)
	const full: PluginManifest = {
		version: '1.0.0',
		description: 'a plugin',
		...manifest,
	} as PluginManifest
	await writeFile(join(root, 'namzu-plugin.json'), JSON.stringify(full), 'utf-8')

	for (const skill of skills) {
		const skillDir = join(root, skill.dir)
		await mkdir(skillDir, { recursive: true })
		await writeFile(
			join(skillDir, 'SKILL.md'),
			`---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n\nthe body of ${skill.name}\n`,
			'utf-8',
		)
	}
	return root
}

function manager(skillRegistry?: SkillRegistry) {
	const pluginRegistry = new PluginRegistry()
	return {
		pluginRegistry,
		manager: new PluginLifecycleManager({
			pluginRegistry,
			toolRegistry: new ToolRegistry(),
			log: NOOP_LOGGER,
			...(skillRegistry ? { skillRegistry } : {}),
		}),
	}
}

function installed(rootDir: string, manifest: PluginManifest): PluginDefinition {
	return {
		id: 'plg_test' as PluginId,
		manifest,
		rootDir,
		status: 'installed',
		scope: 'project',
		installedAt: Date.now(),
	} as PluginDefinition
}

describe('a plugin’s skills load and are namespaced', () => {
	it('registers them, and reaches the model through the prompt', async () => {
		// The whole point. A skill in the registry that never reaches the
		// assembled prompt is a skill the model cannot use.
		const skills = new SkillRegistry(NOOP_LOGGER)
		const manifest = {
			name: 'ledger',
			version: '1.0.0',
			description: 'ledger tools',
			skills: ['skills/reconcile'],
		} as PluginManifest
		const root = await pluginDir(manifest, [
			{ dir: 'skills/reconcile', name: 'reconcile', description: 'reconcile two ledgers' },
		])
		const { pluginRegistry, manager: mgr } = manager(skills)
		pluginRegistry.register(installed(root, manifest))

		await mgr.enable('plg_test' as PluginId)

		expect(skills.has('ledger__reconcile')).toBe(true)
		const prompt = assembleSystemPrompt({ identity: { role: 'A', description: 'x' } }, [
			...skills.list(),
		])
		expect(prompt).toContain('ledger__reconcile')
	})

	it('namespaces so two plugins shipping one name do not overwrite', async () => {
		// A Map keyed by the frontmatter name would have the loser vanish
		// with nothing reporting it.
		const skills = new SkillRegistry(NOOP_LOGGER)
		for (const plugin of ['alpha', 'beta']) {
			const manifest = {
				name: plugin,
				version: '1.0.0',
				description: 'p',
				skills: ['skills/reconcile'],
			} as PluginManifest
			const root = await pluginDir(manifest, [
				{ dir: 'skills/reconcile', name: 'reconcile', description: `${plugin} version` },
			])
			const { pluginRegistry, manager: mgr } = manager(skills)
			pluginRegistry.register(installed(root, manifest))
			await mgr.enable('plg_test' as PluginId)
		}

		expect(skills.has('alpha__reconcile')).toBe(true)
		expect(skills.has('beta__reconcile')).toBe(true)
		expect(skills.size).toBe(2)
	})

	it('carries the namespaced name in the skill’s own metadata', async () => {
		// The registry key and the skill's `metadata.name` must agree, or a
		// prompt rendered from the skill objects shows one name while
		// anything looking the skill up needs the other.
		const skills = new SkillRegistry(NOOP_LOGGER)
		const manifest = {
			name: 'ledger',
			version: '1.0.0',
			description: 'p',
			skills: ['skills/reconcile'],
		} as PluginManifest
		const root = await pluginDir(manifest, [
			{ dir: 'skills/reconcile', name: 'reconcile', description: 'd' },
		])
		const { pluginRegistry, manager: mgr } = manager(skills)
		pluginRegistry.register(installed(root, manifest))

		await mgr.enable('plg_test' as PluginId)

		expect(skills.get('ledger__reconcile')?.metadata.name).toBe('ledger__reconcile')
	})
})

describe('a host with no skill registry is refused, not quietly served', () => {
	it('refuses at the manifest check', () => {
		// The default. A host that never supplied a registry would otherwise
		// install a plugin whose skills go nowhere — the same lie the
		// wholesale refusal was written to prevent.
		expect(() =>
			assertEnableable({
				name: 'ledger',
				version: '1.0.0',
				description: 'p',
				skills: ['skills/reconcile'],
			} as PluginManifest),
		).toThrow(/skills/)
	})

	it('accepts the same manifest when a registry is configured', () => {
		expect(() =>
			assertEnableable(
				{
					name: 'ledger',
					version: '1.0.0',
					description: 'p',
					skills: ['skills/reconcile'],
				} as PluginManifest,
				{ skillsSupported: true },
			),
		).not.toThrow()
	})

	it('still refuses connectors and personas, registry or not', () => {
		// Those have no manifest path yet, and a registry for skills does not
		// buy them one.
		expect(() =>
			assertEnableable(
				{
					name: 'p',
					version: '1.0.0',
					description: 'p',
					skills: ['skills/a'],
					connectors: ['c'],
					personas: ['x'],
				} as PluginManifest,
				{ skillsSupported: true },
			),
		).toThrow(/connectors, personas/)
	})

	it('names them in manifest order, not in registry-grouping order', () => {
		// `connectors, personas, skills` would read as though the grouping
		// were the point rather than an implementation detail of which
		// registry each one needs.
		expect(() =>
			assertEnableable({
				name: 'p',
				version: '1.0.0',
				description: 'p',
				skills: ['a'],
				connectors: ['c'],
				personas: ['x'],
			} as PluginManifest),
		).toThrow(/skills, connectors, personas/)
	})
})

describe('what a plugin brought, it takes away', () => {
	it('unregisters its skills on disable', async () => {
		// A disabled plugin whose skills stayed registered keeps offering the
		// model instructions from something the runtime has switched off —
		// worse than a stale tool, because a tool call would at least fail
		// and a skill is followed silently.
		const skills = new SkillRegistry(NOOP_LOGGER)
		const manifest = {
			name: 'ledger',
			version: '1.0.0',
			description: 'p',
			skills: ['skills/reconcile'],
		} as PluginManifest
		const root = await pluginDir(manifest, [
			{ dir: 'skills/reconcile', name: 'reconcile', description: 'd' },
		])
		const { pluginRegistry, manager: mgr } = manager(skills)
		pluginRegistry.register(installed(root, manifest))
		await mgr.enable('plg_test' as PluginId)

		await mgr.disable('plg_test' as PluginId)

		expect(skills.has('ledger__reconcile')).toBe(false)
	})

	it('rolls back the skills it already loaded when a later one fails', async () => {
		// Half-enabled is the state this rollback exists to prevent: the
		// plugin is marked `error`, and its first skill would otherwise stay
		// in the registry with nothing that could remove it.
		const skills = new SkillRegistry(NOOP_LOGGER)
		const manifest = {
			name: 'ledger',
			version: '1.0.0',
			description: 'p',
			skills: ['skills/good', 'skills/missing'],
		} as PluginManifest
		const root = await pluginDir(manifest, [{ dir: 'skills/good', name: 'good', description: 'd' }])
		const { pluginRegistry, manager: mgr } = manager(skills)
		pluginRegistry.register(installed(root, manifest))

		await expect(mgr.enable('plg_test' as PluginId)).rejects.toThrow()

		expect(skills.has('ledger__good')).toBe(false)
		expect(skills.size).toBe(0)
	})
})
