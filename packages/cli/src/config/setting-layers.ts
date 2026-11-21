/**
 * Which layer decides a setting's value when it is not the user's own file.
 *
 * The loader merges, weakest to strongest: defaults, the user file, the project files
 * (`namzu.config.json`, then `.namzu/settings.json`), the project's local files (the earlier
 * `namzu.config.local.json`, then `.namzu/settings.local.json`), a profile, the environment, the
 * managed (administrator) file. Desktop shows the user
 * file, so a row must say when a stronger layer is what the engine actually uses. This reads the
 * same files and variables the loader reads, per key, and never throws: a file that does not parse
 * is the loader's to refuse at start-up, and here it is simply not a layer.
 *
 * A profile is not reported: which one is in force belongs to a launch (`--profile`), not to the
 * host that shows the settings.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolveAutoCompactWindowSetting } from '@namzu/sdk'

import { readSwitch } from '../integrations/auto-update/policy.js'
import { fullscreenFromEnv } from '../tui/fullscreen/mode.js'
import { MANAGED_CONFIG_PATH, projectLayerHolds } from './load.js'
import { positiveTokenCount } from './model-environment.js'
import { localConfigFiles, projectConfigFiles } from './project-files.js'

export type EffectiveLayer = 'project' | 'local' | 'managed' | 'env'

export interface LayerAnswer {
	readonly layer: EffectiveLayer
	/** The value that layer gives, as the loader reads it. Absent when an environment value is unusable. */
	readonly effective?: unknown
	/** For `env`: the variable and what it holds (never a secret: only these model, size and switch keys). */
	readonly env?: { readonly variable: string; readonly value: string }
}

export interface LayerOptions {
	readonly env: NodeJS.ProcessEnv
	readonly cwd: string
	readonly managedPath?: string
}

interface EnvBinding {
	readonly variable: string
	/** The value the loader takes from the variable, or `undefined` when it takes none. */
	readonly read: (raw: string, variable: string) => unknown
}

const word = (raw: string): string | undefined => {
	const text = raw.trim()
	return text === '' ? undefined : text
}

/** Switches the loader reads from the environment: exactly these four spellings. */
const loaderSwitch = (raw: string): boolean | undefined =>
	raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : undefined

/** The settings a `NAMZU_*` variable decides, by the variable the loader (or the updater) reads. */
export const ENVIRONMENT_BINDINGS: Readonly<Record<string, EnvBinding>> = {
	smallModel: { variable: 'NAMZU_SMALL_MODEL', read: word },
	'limits.maxResponseTokens': {
		variable: 'NAMZU_MAX_OUTPUT_TOKENS',
		read: (raw, variable) => {
			try {
				return positiveTokenCount(raw, variable)
			} catch {
				return undefined
			}
		},
	},
	'compaction.autoCompactWindowTokens': {
		variable: 'NAMZU_AUTO_COMPACT_WINDOW',
		read: (raw, variable) => resolveAutoCompactWindowSetting(raw, variable).tokens,
	},
	format: {
		variable: 'NAMZU_FORMAT',
		read: (raw) => (raw === 'text' || raw === 'json' || raw === 'yaml' ? raw : undefined),
	},
	quiet: { variable: 'NAMZU_QUIET', read: loaderSwitch },
	disableHooks: { variable: 'NAMZU_DISABLE_HOOKS', read: loaderSwitch },
	modelCatalogueRefresh: {
		variable: 'NAMZU_MODEL_CATALOGUE_REFRESH',
		read: loaderSwitch,
	},
	'updates.auto': {
		variable: 'NAMZU_AUTO_UPDATE',
		read: (raw) => readSwitch(raw),
	},
	'updates.check': {
		variable: 'NAMZU_UPDATE_CHECK',
		read: (raw) => readSwitch(raw),
	},
	'updates.channel': {
		variable: 'NAMZU_UPDATE_CHANNEL',
		read: (raw) => {
			const text = raw.trim().toLowerCase()
			return text === 'latest' || text === 'stable' ? text : undefined
		},
	},
	'tui.fullscreen': {
		variable: 'NAMZU_FULLSCREEN',
		read: (raw) => fullscreenFromEnv({ NAMZU_FULLSCREEN: raw }),
	},
}

/**
 * Keys a project file may not carry (the loader drops them before reading it), so a value found
 * there is not in force. The local file's list is the same but for `smallModel`.
 */
const PROJECT_DROPPED = [
	'agentSettings',
	'decision',
	'model',
	'routing',
	'smallModel',
	'memory.select',
	'memory.curation',
	'memory.retireAfterDays',
	'memory.fromConversations',
	'memory.searchPastConversations',
]
const LOCAL_DROPPED = [
	'agentSettings',
	'decision',
	'model',
	'routing',
	'memory.select',
	'memory.curation',
	'memory.retireAfterDays',
	'memory.fromConversations',
	'memory.searchPastConversations',
]

function readJson(file: string): Record<string, unknown> {
	try {
		if (!existsSync(file)) return {}
		const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''))
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {}
	} catch {
		return {}
	}
}

function lookup(doc: unknown, path: readonly string[]): unknown {
	let at = doc
	for (const segment of path) {
		if (at === null || typeof at !== 'object' || Array.isArray(at)) return undefined
		at = (at as Record<string, unknown>)[segment]
	}
	return at
}

/** Reads the project, local and managed files once, for every row. */
export function layerReader(opts: LayerOptions): (path: string) => LayerAnswer | undefined {
	// Each layer's files strongest first: `.namzu/settings.json` over `namzu.config.json`, the
	// local file over its earlier name.
	const project = projectConfigFiles(opts.cwd)
		.map((file) => readJson(file.path))
		.reverse()
	const local = localConfigFiles(opts.cwd)
		.map((file) => readJson(file.path))
		.reverse()
	const managed = readJson(opts.managedPath ?? MANAGED_CONFIG_PATH)
	return (path) => {
		const segments = path.split('.')
		const binding = ENVIRONMENT_BINDINGS[path]
		const raw = binding ? opts.env[binding.variable] : undefined
		// The terminal app reads NAMZU_FULLSCREEN before any config value, whichever file it came from.
		const envFirst = path === 'tui.fullscreen' && binding && raw !== undefined
		const fromManaged = envFirst ? undefined : lookup(managed, segments)
		if (fromManaged !== undefined) return { layer: 'managed', effective: fromManaged }
		// With the update check switched off nothing in updates.auto can take effect.
		const checkOff =
			path === 'updates.auto' && readSwitch(opts.env.NAMZU_UPDATE_CHECK ?? '') === false
		if (checkOff) {
			return {
				layer: 'env',
				effective: false,
				env: { variable: 'NAMZU_UPDATE_CHECK', value: (opts.env.NAMZU_UPDATE_CHECK ?? '').trim() },
			}
		}
		if (binding && raw !== undefined) {
			const effective = binding.read(raw, binding.variable)
			return {
				layer: 'env',
				...(effective !== undefined ? { effective } : {}),
				env: { variable: binding.variable, value: raw.trim() },
			}
		}
		const held = (docs: readonly Record<string, unknown>[], dropped: readonly string[]) => {
			if (dropped.some((key) => path === key || path.startsWith(`${key}.`))) return undefined
			for (const doc of docs) {
				const value = lookup(doc, segments)
				if (value !== undefined && projectLayerHolds(path, value)) return value
			}
			return undefined
		}
		const fromLocal = held(local, LOCAL_DROPPED)
		if (fromLocal !== undefined) return { layer: 'local', effective: fromLocal }
		const fromProject = held(project, PROJECT_DROPPED)
		if (fromProject !== undefined) return { layer: 'project', effective: fromProject }
		return undefined
	}
}
