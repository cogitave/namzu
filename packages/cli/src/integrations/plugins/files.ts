import { readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
	type PluginManifest,
	discoverAllPluginDirs,
	loadPluginManifest,
	resolveWithinReal,
} from '@namzu/sdk'

import type { PluginConfig, PluginScope } from '../../config/schema.js'
import { resolveNamzuHome } from '../state/home.js'
import { isTrusted } from '../trust/store.js'
import { CHECK_HINT, checkHint } from './check-hint.js'
import { loadInstalledManifest, planInstalledPlugins } from './installed-source.js'
import { isReservedPluginDir } from './records.js'
import { PluginSettingsStore } from './settings.js'

export { CHECK_HINT, checkHint }

/** A folder of markdown files one plugin contributes. */
export interface PluginFileDir {
	readonly plugin: string
	/** Canonical absolute folder, inside the plugin's own folder. */
	readonly dir: string
	/**
	 * Set when the plugin named one file rather than a folder: the file's name
	 * without `.md`. Only that file of `dir` is the plugin's.
	 */
	readonly only?: string
	/** The plugin's own folder, for `${NAMZU_PLUGIN_ROOT}` in the file's text. */
	readonly root?: string
	/** The plugin was read through the common plugin layout. */
	readonly commonLayout?: boolean
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

/** What one declared folder resolves to: inside the plugin, outside it, or not there. */
export type PluginFileDirResolution =
	| { readonly kind: 'inside'; readonly dir: string; readonly only?: string }
	| { readonly kind: 'outside' }
	| { readonly kind: 'missing' }

/**
 * One declared folder, resolved inside its plugin's folder. The rule the
 * session and `namzu plugin validate` share: a link that leads out of the
 * plugin folder is refused, not followed.
 */
export function resolvePluginFileDir(rootDir: string, rel: string): PluginFileDirResolution {
	try {
		const real = realpathSync(join(rootDir, rel))
		const within = relative(realpathSync(rootDir), real)
		if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
			return { kind: 'outside' }
		}
		// One markdown file named directly: its folder, and which file in it.
		if (statSync(real).isFile()) {
			if (!real.toLowerCase().endsWith('.md')) return { kind: 'missing' }
			return {
				kind: 'inside',
				dir: dirname(real),
				only: basename(real).slice(0, -'.md'.length),
			}
		}
		return { kind: 'inside', dir: real }
	} catch {
		return { kind: 'missing' }
	}
}

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
	layout?: 'common',
): {
	readonly dirs: readonly PluginFileDir[]
	readonly problems: readonly string[]
} {
	const dirs: PluginFileDir[] = []
	const problems: string[] = []
	for (const rel of declared ?? []) {
		const found = resolvePluginFileDir(rootDir, rel)
		if (found.kind === 'inside') {
			dirs.push({
				plugin,
				dir: found.dir,
				root: rootDir,
				...(layout === 'common' ? { commonLayout: true } : {}),
				...(found.only !== undefined ? { only: found.only } : {}),
			})
		} else if (found.kind === 'outside') {
			problems.push(
				`Plugin "${plugin}": "${rel}" leads outside the plugin folder, so it is not used. ${checkHint(rootDir)}`,
			)
		} else {
			problems.push(`Plugin "${plugin}": the folder "${rel}" was not found. ${checkHint(rootDir)}`)
		}
	}
	return { dirs, problems }
}

/** The `.md` file names (without the extension) a folder holds, sorted; just `only` when one file was named. */
export function listMarkdownNames(dir: string, only?: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
			.map((entry) => entry.name.slice(0, -'.md'.length))
			.filter((name) => only === undefined || name === only)
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
	/** Whether `cwd` is trusted; absent, the trust list says. */
	readonly projectTrusted?: boolean
}): Promise<PluginFileSources> {
	const { config, cwd } = options
	const userRoot = options.userRoot ?? resolveNamzuHome()
	const launchDirs = config?.launchDirs ?? []
	if (config?.enabled !== true && launchDirs.length === 0) return EMPTY_PLUGIN_FILE_SOURCES

	const found: { dir: string; authority: string }[] = []
	const launched: string[] = []
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
				if (scope === 'user' && isReservedPluginDir(userRoot, dir)) continue
				found.push({ dir, authority: scope === 'project' ? cwd : userRoot })
			}
		}
	}
	for (const dir of launchDirs) launched.push(dir)

	const settings = new PluginSettingsStore(userRoot)
	const commands: PluginFileDir[] = []
	const agents: PluginFileDir[] = []
	const problems: string[] = []
	const names = new Set<string>()
	const take = (manifest: PluginManifest, rootDir: string): void => {
		names.add(manifest.name)
		const c = resolvePluginFileDirs(manifest.name, rootDir, manifest.commands, manifest.layout)
		const a = resolvePluginFileDirs(manifest.name, rootDir, manifest.agents, manifest.layout)
		commands.push(...c.dirs)
		agents.push(...a.dirs)
		problems.push(...c.problems, ...a.problems)
	}
	const fromFolder = async (dir: string, authority: string): Promise<void> => {
		try {
			const rootDir = await resolveWithinReal(authority, dir)
			const manifest = await loadPluginManifest(rootDir, { skillsSupported: true })
			// A disabled plugin still holds its name, as it does in the runtime.
			names.add(manifest.name)
			if (!settings.read({ rootDir, name: manifest.name })) return
			take(manifest, rootDir)
		} catch (error) {
			// The runtime reports a broken plugin when it starts. Here it only
			// means this plugin adds no files.
			problems.push(
				`A plugin in ${dir} was skipped: ${error instanceof Error ? error.message : String(error)} ${checkHint(dir)}`,
			)
		}
	}
	for (const { dir, authority } of found) await fromFolder(dir, authority)
	// Installed plugins: the same ones the runtime admits, and a name a
	// hand-placed or `--plugin-dir` plugin already holds is not theirs.
	if (config?.enabled === true) {
		const launchNames = new Set<string>()
		for (const dir of launched) {
			try {
				launchNames.add((await loadPluginManifest(dir, { skillsSupported: true })).name)
			} catch {
				// Reported when that folder is read below.
			}
		}
		const plan = planInstalledPlugins({
			home: userRoot,
			cwd,
			projectTrusted: options.projectTrusted ?? isTrustedFolder(cwd),
			allowedScopes: config.allowedScopes ?? ['project', 'user'],
		})
		for (const candidate of plan.candidates) {
			if (!candidate.answer.on || names.has(candidate.name) || launchNames.has(candidate.name))
				continue
			try {
				take(
					await loadInstalledManifest(candidate, { home: userRoot, cwd, installedNames: names }),
					candidate.installPath,
				)
			} catch (error) {
				problems.push(
					`${candidate.id} was skipped: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}
	for (const dir of launched) await fromFolder(dir, dir)
	return { commands, agents, problems }
}

function isTrustedFolder(cwd: string): boolean {
	try {
		return isTrusted(cwd)
	} catch {
		return false
	}
}
