/**
 * Where a project's and a user's agent files live.
 *
 * What an agent file MEANS is the kernel's decision (`@namzu/sdk`
 * `agents/file-definitions`): the frontmatter, the allowlist, the refusals.
 * This file only says which directories this application reads, in which
 * order — user first, project second, so a project file shadows a user one
 * with the same name — and hands the kernel the roots.
 */

import { join } from 'node:path'

import {
	type AgentFileDefinition,
	type DiscoveredAgentDefinitions,
	discoverAgentDefinitions as discoverFromRoots,
} from '@namzu/sdk'

import type { SkillsConfig } from '../../config/schema.js'
import { PERMISSION_MODE_NAMES } from '../../permissions/mode-names.js'
import { discoverSkills, loadSkillBody } from '../../skills/store.js'
import { namzuHomePath } from '../state/home.js'

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
	readonly pluginAgentDirs?: readonly { readonly plugin: string; readonly dir: string }[]
}): Promise<LoadedAgentDefinitions> {
	const fromPlugins = await Promise.all(
		(opts.pluginAgentDirs ?? []).map(async ({ plugin, dir }) => {
			const found = await discoverFromRoots([{ dir, source: 'plugin' }], {
				permissionModes: AGENT_FILE_PERMISSION_MODES,
			})
			return {
				definitions: found.definitions.map((definition) => ({
					...definition,
					name: `${plugin}__${definition.name}`,
				})),
				skipped: found.skipped,
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
	const found = {
		definitions: [...byName.values()],
		skipped: [...fromPlugins.flatMap((set) => set.skipped), ...own.skipped],
	}
	if (!found.definitions.some((definition) => definition.skills !== undefined)) {
		return { ...found, missingSkills: [] }
	}
	const roster = new Map(
		discoverSkills({
			cwd: opts.cwd,
			...(opts.home !== undefined ? { home: opts.home } : {}),
			...(opts.skills ? { config: opts.skills } : {}),
		}).map((skill) => [skill.name, skill]),
	)
	const missingSkills: { path: string; reason: string }[] = []
	const definitions = found.definitions.map((definition) => {
		if (definition.skills === undefined) return definition
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
				blocks.push(`### Skill: ${name}\n\n${loadSkillBody(skill)}`)
			} catch (error) {
				missingSkills.push({
					path: definition.path,
					reason: `skill ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
				})
			}
		}
		if (blocks.length === 0) return definition
		return {
			...definition,
			prompt: `${definition.prompt}\n\nThese skills are loaded for you. Apply their guidance when it fits the task.\n\n${blocks.join('\n\n')}`,
		}
	})
	return { definitions, skipped: found.skipped, missingSkills }
}
