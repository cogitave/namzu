/**
 * The skills a session offers the MODEL.
 *
 * `store.ts` discovers `SKILL.md` files for the operator. Until this module
 * existed those files reached the model only when the operator pasted one in
 * (`/skills <name>`, `exec --skills`): the kernel's manifest and its `skill`
 * tool were wired for plugin skills alone. This builds one SDK
 * `SkillRegistry` per session from the discovered tiers and, per turn, merges
 * it with the plugin runtime's registry into what the turn receives:
 *
 *   - `registry` — what the `skill` tool loads from (and lists, paged);
 *   - `manifest` — the skills described in the prompt's `<available_skills>`;
 *   - `overflowNote` — the names that did not fit the manifest's budget.
 *
 * Metadata only until the model asks: a skill's body is read when the `skill`
 * tool loads it, never at session start.
 *
 * ## Gating
 *
 * A skill whose `metadata.namzu-requires-tools` names a tool the turn does
 * not have is hidden from both the manifest and the tool — instructions for a
 * capability the session lacks read as a capability to go looking for.
 *
 * ## Budget
 *
 * The manifest costs prompt on every request, so it is capped at
 * min(2% of the context window, 4 KB). Skills that do not fit are named in
 * one line and stay loadable; the `skill` tool lists them with descriptions,
 * paged, when called without a name.
 */

import { dirname } from 'node:path'
import {
	type Logger,
	SKILL_TOOL_NAME,
	type Skill,
	SkillRegistry,
	type SkillRegistryRef,
	isInvocableBy,
} from '@namzu/sdk'

import type { SkillsConfig } from '../config/schema.js'
import {
	SKILL_TIERS,
	type SkillDiscoveryOptions,
	type SkillInfo,
	discoverSkills,
	parseRequiredTools,
} from './store.js'

/** The manifest never costs more than this many characters. */
export const SKILL_MANIFEST_MAX_CHARS = 4096
/** Share of the context window the manifest may take. */
export const SKILL_MANIFEST_WINDOW_SHARE = 0.02
/** The kernel's own chars-per-token estimate. */
const CHARS_PER_TOKEN = 4

/** min(2% of the window, 4 KB), in characters. */
export function skillManifestBudget(contextWindowTokens: number): number {
	const share = Math.floor(contextWindowTokens * SKILL_MANIFEST_WINDOW_SHARE * CHARS_PER_TOKEN)
	return Math.max(0, Math.min(SKILL_MANIFEST_MAX_CHARS, share))
}

/**
 * What one skill's `<skill>` entry costs in the manifest. Mirrors the
 * kernel's `renderSkillsSection` entry closely enough to budget with; the
 * section's fixed preamble is not counted — it is paid once whatever fits.
 */
export function manifestEntryChars(skill: Skill): number {
	const m = skill.metadata
	let chars =
		'<skill>\n<name></name>\n<description></description>\n<location>/SKILL.md</location>\n</skill>\n'
			.length +
		m.name.length +
		m.description.trim().length +
		skill.dirPath.length
	if (m.compatibility) chars += '<compatibility></compatibility>\n'.length + m.compatibility.length
	if (m.license) chars += '<license></license>\n'.length + m.license.length
	if (m.allowedTools) chars += '<allowed_tools></allowed_tools>\n'.length + m.allowedTools.length
	return chars
}

/** The tools a skill says the session must have; see the module comment. */
export function requiredToolsOf(skill: Skill): readonly string[] {
	const metadata = skill.metadata.metadata
	const declared =
		metadata && Object.hasOwn(metadata, 'namzu-requires-tools')
			? metadata['namzu-requires-tools']
			: undefined
	return parseRequiredTools(declared) ?? []
}

export interface TurnSkillsInput {
	/** Every tool name registered for the turn: what gating is checked against. */
	readonly toolNames: readonly string[]
	/** The window the turn runs against, for the manifest budget. */
	readonly contextWindowTokens: number
	/** The plugin runtime's registry, when plugins are on. */
	readonly pluginSkills?: SkillRegistry
}

export interface TurnSkills {
	/** What the `skill` tool loads from; undefined when there is nothing to load. */
	readonly registry: SkillRegistryRef | undefined
	/** What the prompt's `<available_skills>` describes; undefined when empty. */
	readonly manifest: Skill[] | undefined
	/** One line naming the skills the budget left out, or null. */
	readonly overflowNote: string | null
	/** The names left out of the manifest, in order. */
	readonly overflow: readonly string[]
}

export interface SessionSkillCatalog {
	/** The file skills registered for the model, highest precedence first. */
	readonly fileSkills: readonly SkillInfo[]
	/** Whether the session should carry the `skill` tool for file skills. */
	readonly hasFileSkills: boolean
	forTurn(input: TurnSkillsInput): Promise<TurnSkills>
}

export interface SessionSkillCatalogOptions {
	readonly cwd: string
	readonly home?: string
	readonly config?: SkillsConfig
	readonly systemDir?: string
	readonly log?: Logger
}

/**
 * Discover the file tiers once and register each usable winner's metadata.
 *
 * A file the kernel loader refuses (a name that does not match its
 * directory, a missing description, a contradictory `invocation`) is left
 * out of the model's catalog with a warning; the operator still sees it in
 * `/skills list` and can still activate it by name.
 */
export async function createSessionSkillCatalog(
	options: SessionSkillCatalogOptions,
): Promise<SessionSkillCatalog> {
	const discovery: SkillDiscoveryOptions = {
		cwd: options.cwd,
		...(options.home !== undefined ? { home: options.home } : {}),
		...(options.config ? { config: options.config } : {}),
		...(options.systemDir !== undefined ? { systemDir: options.systemDir } : {}),
	}
	const files = new SkillRegistry(options.log)
	const registered: SkillInfo[] = []
	const candidates = discoverSkills(discovery)
		.filter((skill) => skill.problem === undefined && skill.disabled !== true)
		// Highest precedence first: when the budget runs out, the project's own
		// skills are the last to lose their description.
		.sort(
			(a, b) =>
				SKILL_TIERS.indexOf(b.tier) - SKILL_TIERS.indexOf(a.tier) || a.name.localeCompare(b.name),
		)
	for (const skill of candidates) {
		try {
			await files.register(dirname(skill.path), 'metadata')
			registered.push(skill)
		} catch (error) {
			options.log?.warn('skill not offered to the model', {
				'namzu.skill.name': skill.name,
				'namzu.skill.path': skill.path,
				'namzu.skill.reason': error instanceof Error ? error.message : String(error),
			})
		}
	}
	const order = registered.map((skill) => skill.name)

	return {
		fileSkills: registered,
		hasFileSkills: registered.length > 0,
		async forTurn(input) {
			const tools = new Set(input.toolNames)
			const gated = (skill: Skill): boolean =>
				requiredToolsOf(skill).every((name) => tools.has(name))

			// `load` re-reads a changed file and drops a deleted one, so an edit
			// made while the session runs reaches the next turn.
			const fileSkills: Skill[] = []
			for (const name of order) {
				const loaded = await files.load(name, 'metadata')
				if (!loaded || !gated(loaded.skill)) continue
				// Metadata only. The registry keeps a body once the model has loaded
				// it, and the kernel pastes any body it is handed into the prompt
				// under "Loaded Skills" — every later request would then carry a
				// second copy of what the tool result already put in the history.
				const { body: _body, ...metadataOnly } = loaded.skill
				fileSkills.push(metadataOnly)
			}
			const offered = new Set(fileSkills.map((skill) => skill.metadata.name))

			const plugins = input.pluginSkills
			const pluginSkills: Skill[] = []
			if (plugins) {
				for (const name of plugins.names()) {
					const loaded = await plugins.load(name, 'metadata')
					if (loaded) pluginSkills.push(loaded.skill)
				}
			}

			const all = [...fileSkills, ...pluginSkills]
			if (all.length === 0) {
				return { registry: undefined, manifest: undefined, overflowNote: null, overflow: [] }
			}

			const budget = skillManifestBudget(input.contextWindowTokens)
			const manifest: Skill[] = []
			const overflow: string[] = []
			let spent = 0
			for (const skill of all) {
				// Operator-only skills are not in the manifest at all; the kernel
				// filters them too, and they must not use up its budget.
				if (!isInvocableBy(skill, 'model')) {
					manifest.push(skill)
					continue
				}
				const cost = manifestEntryChars(skill)
				if (overflow.length === 0 && spent + cost <= budget) {
					manifest.push(skill)
					spent += cost
				} else {
					overflow.push(skill.metadata.name)
				}
			}

			const registry: SkillRegistryRef = {
				names: () => [...offered, ...(plugins ? plugins.names() : [])],
				async catalog() {
					const fileEntries = (await files.catalog()).filter((entry) =>
						offered.has(entry.registeredName),
					)
					const pluginEntries = plugins ? await plugins.catalog() : []
					return [...fileEntries, ...pluginEntries]
				},
				async load(name) {
					if (offered.has(name)) return files.load(name)
					if (plugins?.has(name)) return plugins.load(name)
					return undefined
				},
			}

			return {
				registry,
				manifest: manifest.length > 0 ? manifest : undefined,
				overflowNote: overflowNote(overflow),
				overflow,
			}
		},
	}
}

/** The one line naming skills the manifest had no room to describe. */
export function overflowNote(names: readonly string[]): string | null {
	if (names.length === 0) return null
	return `More skills are available than the skills manifest describes: ${names.join(', ')}. Call the \`${SKILL_TOOL_NAME}\` tool without a name to list them with descriptions, or with a name to load one when the task matches it.`
}
