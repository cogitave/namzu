import { readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { discoverAllPluginDirs, loadPluginManifest, resolveWithinReal } from '@namzu/sdk'

import type { PluginConfig, PluginScope } from '../../config/schema.js'
import { resolveNamzuHome } from '../state/home.js'
import { PluginSettingsStore } from './settings.js'

/** A folder of markdown files one plugin contributes. */
export interface PluginFileDir {
	readonly plugin: string
	/** Canonical absolute folder, inside the plugin's own folder. */
	readonly dir: string
}

/** What the plugins on disk contribute as plain markdown files. */
export interface PluginFileSources {
	readonly commands: readonly PluginFileDir[]
	readonly agents: readonly PluginFileDir[]
	/** Declared folders that were refused or missing, in words for the log. */
	readonly problems: readonly string[]
}

export const EMPTY_PLUGIN_FILE_SOURCES: PluginFileSources = Object.freeze({
	commands: [],
	agents: [],
	problems: [],
})

/**
 * The folders a plugin declared, resolved inside its own folder.
 *
 * A link that leads out of the plugin folder is refused, not followed, the
 * same rule the plugin's tool and skill paths already obey.
 */
export function resolvePluginFileDirs(
	plugin: string,
	rootDir: string,
	declared: readonly string[] | undefined,
): { readonly dirs: readonly PluginFileDir[]; readonly problems: readonly string[] } {
	const dirs: PluginFileDir[] = []
	const problems: string[] = []
	for (const rel of declared ?? []) {
		try {
			const real = realpathSync(join(rootDir, rel))
			const within = relative(realpathSync(rootDir), real)
			if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
				problems.push(
					`Plugin "${plugin}": "${rel}" leads outside the plugin folder, so it is not used.`,
				)
				continue
			}
			dirs.push({ plugin, dir: real })
		} catch {
			problems.push(`Plugin "${plugin}": the folder "${rel}" was not found.`)
		}
	}
	return { dirs, problems }
}

/** The `.md` file names (without the extension) a folder holds, sorted. */
export function listMarkdownNames(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
			.map((entry) => entry.name.slice(0, -'.md'.length))
			.sort()
	} catch {
		return []
	}
}

/**
 * The command and agent folders of every plugin that starts enabled.
 *
 * Reads manifests and saved start-up settings only: no plugin code is
 * imported and nothing is started. It mirrors which plugins the runtime
 * admits (`plugins.enabled`, the allowed locations, the saved state) plus
 * the folders named with `--plugin-dir`, so a plugin that does not start does
 * not contribute either. A folder that cannot be read is reported in
 * `problems` and skipped.
 */
export async function readPluginFileSources(options: {
	readonly config?: PluginConfig | undefined
	readonly cwd: string
	readonly userRoot?: string
}): Promise<PluginFileSources> {
	const { config, cwd } = options
	const userRoot = options.userRoot ?? resolveNamzuHome()
	const launchDirs = config?.launchDirs ?? []
	if (config?.enabled !== true && launchDirs.length === 0) return EMPTY_PLUGIN_FILE_SOURCES

	const found: { dir: string; authority: string }[] = []
	if (config?.enabled === true) {
		const allowedScopes: readonly PluginScope[] = config.allowedScopes ?? ['project', 'user']
		const discovered = await discoverAllPluginDirs(cwd, {
			enabled: true,
			autoDiscovery: config.autoDiscovery ?? true,
			allowedScopes,
			userRoot,
		})
		for (const scope of allowedScopes) {
			for (const dir of [...discovered[scope]].sort((a, b) => a.localeCompare(b))) {
				found.push({ dir, authority: scope === 'project' ? cwd : userRoot })
			}
		}
	}
	for (const dir of launchDirs) found.push({ dir, authority: dir })

	const settings = new PluginSettingsStore(userRoot)
	const commands: PluginFileDir[] = []
	const agents: PluginFileDir[] = []
	const problems: string[] = []
	for (const { dir, authority } of found) {
		try {
			const rootDir = await resolveWithinReal(authority, dir)
			const manifest = await loadPluginManifest(rootDir, { skillsSupported: true })
			if (!settings.read({ rootDir, name: manifest.name })) continue
			const c = resolvePluginFileDirs(manifest.name, rootDir, manifest.commands)
			const a = resolvePluginFileDirs(manifest.name, rootDir, manifest.agents)
			commands.push(...c.dirs)
			agents.push(...a.dirs)
			problems.push(...c.problems, ...a.problems)
		} catch (error) {
			// The runtime reports a broken plugin when it starts. Here it only
			// means this plugin adds no files.
			problems.push(
				`A plugin in ${dir} was skipped: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return { commands, agents, problems }
}
