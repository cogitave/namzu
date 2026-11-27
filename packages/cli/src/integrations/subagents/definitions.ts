/**
 * Where a project's and a user's agent files live.
 *
 * What an agent file MEANS is the kernel's decision (`@namzu/sdk`
 * `agents/file-definitions`): the frontmatter, the allowlist, the refusals.
 * This file only says which directories this application reads, in which
 * order — user first, project second, so a project file shadows a user one
 * with the same name — and hands the kernel the roots.
 */

import { basename, dirname, join } from 'node:path'

import {
	type AgentFileDefinition,
	type DiscoveredAgentDefinitions,
	discoverAgentDefinitions as discoverFromRoots,
	expandInlineShell,
	expandPluginRootText,
	findInlineShell,
	substituteEscaped,
} from '@namzu/sdk'

import type { HooksSwitch } from '../../config/hook-layers.js'
import type { SkillsConfig } from '../../config/schema.js'
import { PERMISSION_MODE_NAMES } from '../../permissions/mode-names.js'
import type { SessionSkillShell } from '../../skills/skill-shell.js'
import { type SkillInfo, discoverSkills, loadSkillFile } from '../../skills/store.js'
import { namzuHomePath } from '../state/home.js'
import { type AgentHooksCarrier, type RefusedAgent, vetAgentHooks } from './agent-hooks.js'

export type { AgentFileDefinition, SkippedAgentFile } from '@namzu/sdk'

export function userAgentsDir(home?: string): string {
	return join(namzuHomePath(home), 'agents')
}

export function projectAgentsDir(cwd: string): string {
	return join(cwd, '.namzu', 'agents')
}

/** The host's allowed permission modes for agent files. */
export const AGENT_FILE_PERMISSION_MODES: ReadonlySet<string> = new Set([
	...PERMISSION_MODE_NAMES,
	'inherit',
])

/** What discovery found, and the skills an agent file named that could not be loaded. */
export interface LoadedAgentDefinitions extends DiscoveredAgentDefinitions {
	readonly missingSkills: readonly { readonly path: string; readonly reason: string }[]
	/**
	 * Agent files that are not offered because a hook entry that would have
	 * guarded something cannot be loaded (also named in `skipped`).
	 */
	readonly refused: readonly RefusedAgent[]
	/** Every agent file that carries hooks, offered or not. */
	readonly carriers: readonly AgentHooksCarrier[]
}

/**
 * Both directories, project shadowing user. An agent file's `skills` are
 * read here and appended to its prompt, so the runtime only ever sees a
 * finished prompt. A skill that is absent, disabled or unreadable is left
 * out and named in `missingSkills`; the agent still loads.
 * Enabled plugins contribute namespaced agents first; user/project agents
 * take precedence. Permission modes and preloaded skills apply to all roots.
 */
export async function discoverAgentDefinitions(opts: {
	readonly cwd: string
	readonly home?: string
	readonly skills?: SkillsConfig
	readonly pluginAgentDirs?: readonly {
		readonly plugin: string
		readonly dir: string
		/** One file of `dir` (its name without `.md`) when the plugin named a file, not a folder. */
		readonly only?: string
		/** The plugin's folder, put in for `${NAMZU_PLUGIN_ROOT}` in the agent's text. */
		readonly root?: string
	}[]
	/**
	 * What decides whether an agent file's hooks can attach. Absent: the hooks
	 * are read as they would be in a trusted folder with no switch on, which is
	 * what a listing wants.
	 */
	readonly hooks?: {
		readonly hooksSwitch?: HooksSwitch | undefined
		readonly projectTrusted: boolean
	}
	/**
	 * Runs the shell commands a preloaded skill holds, as part of loading it into the agent's
	 * prompt (`invoked_by: other`). Absent, a command in a preloaded skill is not run: it is
	 * replaced by a line saying so. The listings (mentions, the hooks report, the context
	 * gatherer) never pass it, so reading the roster never runs a command.
	 */
	readonly skillShell?: SessionSkillShell
}): Promise<LoadedAgentDefinitions> {
	const fromPlugins = await Promise.all(
		(opts.pluginAgentDirs ?? []).map(async ({ plugin, dir, only, root }) => {
			const found = await discoverFromRoots([{ dir, source: 'plugin' }], {
				permissionModes: AGENT_FILE_PERMISSION_MODES,
			})
			const own = (path: string): boolean => only === undefined || basename(path) === `${only}.md`
			return {
				definitions: found.definitions
					.filter((definition) => own(definition.path))
					.map((definition) => ({
						...definition,
						name: `${plugin}__${definition.name}`,
						...(root !== undefined
							? { prompt: expandPluginRootText(definition.prompt, root) }
							: {}),
					})),
				skipped: found.skipped.filter((skipped) => own(skipped.path)),
			}
		}),
	)
	const own = await discoverFromRoots(
		[
			{ dir: userAgentsDir(opts.home), source: 'user' },
			{ dir: projectAgentsDir(opts.cwd), source: 'project' },
		],
		{ permissionModes: AGENT_FILE_PERMISSION_MODES },
	)
	const byName = new Map<string, AgentFileDefinition>()
	for (const set of fromPlugins)
		for (const definition of set.definitions) byName.set(definition.name, definition)
	for (const definition of own.definitions) byName.set(definition.name, definition)
	// A file whose guard cannot be loaded is not offered, and is named with the entry.
	const carriers: AgentHooksCarrier[] = [...byName.values()].flatMap((definition) =>
		definition.hooksSource === undefined
			? []
			: [
					{
						name: definition.name,
						path: definition.path,
						source: definition.source,
						hooksSource: definition.hooksSource,
					},
				],
	)
	const vetted = vetAgentHooks([...byName.values()], {
		hooksSwitch: opts.hooks?.hooksSwitch,
		projectTrusted: opts.hooks?.projectTrusted ?? true,
	})
	const found = {
		definitions: [...vetted.offered],
		skipped: [
			...fromPlugins.flatMap((set) => set.skipped),
			...own.skipped,
			...vetted.refused.map((refused) => ({ path: refused.path, reason: refused.line })),
		],
	}
	const refused = vetted.refused
	if (!found.definitions.some((definition) => definition.skills !== undefined)) {
		return { ...found, missingSkills: [], refused, carriers }
	}
	const roster = new Map(
		discoverSkills({
			cwd: opts.cwd,
			...(opts.home !== undefined ? { home: opts.home } : {}),
			...(opts.skills ? { config: opts.skills } : {}),
		}).map((skill) => [skill.name, skill]),
	)
	const missingSkills: { path: string; reason: string }[] = []
	const definitions: AgentFileDefinition[] = []
	for (const definition of found.definitions) {
		if (definition.skills === undefined) {
			definitions.push(definition)
			continue
		}
		const blocks: string[] = []
		for (const name of definition.skills) {
			const skill = roster.get(name)
			if (!skill || skill.problem !== undefined) {
				missingSkills.push({
					path: definition.path,
					reason: `skill ${name} ${skill?.problem ? `cannot be used: ${skill.problem}` : 'was not found'}`,
				})
				continue
			}
			try {
				blocks.push(`### Skill: ${name}\n\n${await preloadedBody(skill, opts.skillShell)}`)
			} catch (error) {
				missingSkills.push({
					path: definition.path,
					reason: `skill ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		}
		definitions.push(
			blocks.length === 0
				? definition
				: {
						...definition,
						prompt: `${definition.prompt}\n\nThese skills are loaded for you. Apply their guidance when it fits the task.\n\n${blocks.join('\n\n')}`,
					},
		)
	}
	return { definitions, skipped: found.skipped, missingSkills, refused, carriers }
}

/**
 * A preloaded skill's text. A skill that holds shell commands has them run only
 * when the caller gave an expander for it; otherwise each command is replaced by a
 * line saying it was not run. There are no arguments at a preload, so `$ARGUMENTS` is empty.
 */
async function preloadedBody(
	skill: SkillInfo,
	shell: SessionSkillShell | undefined,
): Promise<string> {
	const { body, allowedTools } = loadSkillFile(skill)
	if (findInlineShell(body).length === 0) return body
	const directory = dirname(skill.path)
	const text = substituteEscaped(body, {
		$ARGUMENTS: '',
		'${NAMZU_SKILL_DIR}': directory,
		'${CLAUDE_SKILL_DIR}': directory,
	})
	if (shell === undefined) {
		return expandInlineShell(text, {
			host: { run: async () => ({ kind: 'denied', reason: 'not run at a preload' }) },
			commandName: skill.name,
			block: 'preload',
		})
	}
	return shell.expand({
		text,
		name: skill.name,
		origin: skill.source,
		invokedBy: 'other',
		...(allowedTools ? { allowedTools } : {}),
		directory,
	})
}
