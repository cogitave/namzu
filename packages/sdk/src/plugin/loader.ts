import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	PLUGIN_MANIFEST_FILENAME,
	PROJECT_PLUGIN_DIR,
	USER_PLUGIN_DIR,
} from '../constants/plugin/index.js'
import { type PluginManifest, PluginManifestSchema } from '../types/plugin/index.js'
import { getRootLogger } from '../utils/logger.js'

/**
 * Scans a directory for subdirectories containing a plugin manifest.
 * Returns an array of absolute paths to plugin directories.
 */
export async function discoverPlugins(parentDir: string): Promise<string[]> {
	// Resolved here, not at module scope. A module-scope
	// `getRootLogger().child(...)` ran once, at import time — before any
	// host's `configureLogger()` call had a chance to run — and `child()`
	// bakes `minLevel` into the closure `log()` reads from forever after
	// (`utils/logger.ts`), so whatever level was live at that one moment
	// was permanent. `configureLogger` replaces the `_rootLogger` binding
	// rather than mutating the object it points at, so caching the CHILD
	// (as this loader did) survives no later call at all — including the
	// CLI's own `configureLogger({ level: 'silent' })`.
	const logger = getRootLogger().child({ component: 'PluginLoader' })
	const dirs: string[] = []

	try {
		const entries = await readdir(parentDir)
		for (const entry of entries) {
			if (entry.startsWith('.') || entry.startsWith('_')) continue
			const fullPath = join(parentDir, entry)
			// `lstat`, not `stat`: `stat` follows the link and reports on its
			// TARGET, so a symlinked entry pointing anywhere on disk was
			// admitted as a plugin directory and its manifest read from there.
			// A plugins directory holds third-party code by definition, which
			// makes following a link out of it the worse half of CWE-59 — the
			// directory listed is not the directory loaded.
			const s = await lstat(fullPath)
			if (s.isSymbolicLink()) {
				logger.warn('Refusing a symlinked plugin directory', { path: fullPath })
				continue
			}
			if (!s.isDirectory()) continue

			const manifestPath = join(fullPath, PLUGIN_MANIFEST_FILENAME)
			try {
				await stat(manifestPath)
				dirs.push(fullPath)
			} catch {
				// No manifest in this directory — skip
			}
		}
	} catch {
		logger.debug('Plugins directory not found', { parentDir })
	}

	return dirs
}

/**
 * Reads and validates a plugin manifest from a plugin directory.
 * Throws on invalid manifest (fail fast).
 */
export async function loadPluginManifest(pluginDir: string): Promise<PluginManifest> {
	const manifestPath = join(pluginDir, PLUGIN_MANIFEST_FILENAME)
	const raw = await readFile(manifestPath, 'utf-8')
	const parsed: unknown = JSON.parse(raw)
	const manifest = PluginManifestSchema.parse(parsed)
	assertEnableable(manifest)
	return manifest
}

/**
 * Contribution types the manifest accepts and the runtime cannot enable.
 *
 * The schema validates `skills`, `connectors` and `personas` with per-type
 * caps, and enabling then refuses all three wholesale — so a plugin
 * shipping four tools and one skill validated clean, installed clean, and
 * contributed zero tools. The refusal was right; its position was not.
 */
const UNSUPPORTED_CONTRIBUTIONS = ['skills', 'connectors', 'personas'] as const

/**
 * Refuse a manifest whose contributions can never be enabled.
 *
 * Checked at LOAD, not at enable. A plugin that cannot enable was being
 * persisted as `installed` — a status that says the opposite — and the
 * author found out only when something tried to use it, at which point
 * every tool it also shipped went down with it. Failing where the manifest
 * is read means the author learns at the moment they are looking at the
 * manifest.
 *
 * The registries these types would need all exist and are wired to agents
 * through host configuration; what does not exist is the manifest path
 * into them. Naming the types is what makes that actionable.
 */
export function assertEnableable(manifest: PluginManifest): void {
	const record = manifest as unknown as Record<string, unknown[] | undefined>
	const unsupported = UNSUPPORTED_CONTRIBUTIONS.filter((key) => record[key]?.length)
	if (unsupported.length === 0) return

	throw new Error(
		`Plugin "${manifest.name}" declares contribution type(s) [${unsupported.join(', ')}] that the runtime cannot enable, so installing it would produce a plugin that reports "installed" and contributes nothing — including its other, supported contributions. Remove them from the manifest, or configure them on the agent directly (the skill, connector and persona registries all accept them that way).`,
	)
}

/** Where a plugin came from. Project plugins ship with the repo; user plugins live in the home directory. */
export type PluginScope = 'project' | 'user'

/**
 * The discovery half of {@link PluginRuntimeConfig}.
 *
 * Structural rather than an import so this module keeps depending on nothing
 * — a parsed `PluginRuntimeConfig` satisfies it as-is.
 */
export interface PluginDiscoveryOptions {
	/** Whether the plugin runtime is on at all. `false` discovers nothing. */
	readonly enabled?: boolean
	/** Whether to scan for plugins. `false` discovers nothing. */
	readonly autoDiscovery?: boolean
	/** Which locations may be scanned. Absent means both. */
	readonly allowedScopes?: readonly PluginScope[]
}

/**
 * Find plugin directories, in the locations the caller permits.
 *
 * `allowedScopes` is a trust boundary, not a filter applied afterwards. A
 * plugin is arbitrary code with hooks into tool execution, and the two scopes
 * are not equally trusted: project plugins are reviewable in the repo the
 * agent is working on, while user plugins come from a home directory the
 * repo's reviewers never see. `['project']` is how a host says the second
 * kind is not allowed to run here.
 *
 * It was previously declared and unread — `PluginRuntimeConfig` carried
 * `enabled`, `autoDiscovery` and `allowedScopes`, nothing anywhere consulted
 * any of them, and this function scanned both locations unconditionally. A
 * host who set `allowedScopes: ['project']` got user plugins anyway, from a
 * setting that reads exactly like a boundary.
 *
 * A disallowed scope is NOT SCANNED rather than scanned and dropped.
 * Filtering after the fact still reads the directory, which is both pointless
 * work and a small disclosure — the returned count would tell a caller how
 * many plugins live somewhere they said they would not look.
 *
 * Passing nothing keeps the old behaviour: both scopes, no gate. Existing
 * callers are unaffected, and a caller who opts in gets what the config says.
 */
export async function discoverAllPluginDirs(
	workingDirectory?: string,
	options?: PluginDiscoveryOptions,
): Promise<{ project: string[]; user: string[] }> {
	// Resolved here too — see discoverPlugins above for why module scope
	// froze this logger's level, and its very reference, at import time.
	const logger = getRootLogger().child({ component: 'PluginLoader' })
	if (options?.enabled === false || options?.autoDiscovery === false) {
		logger.debug('Plugin discovery skipped', {
			enabled: options.enabled,
			autoDiscovery: options.autoDiscovery,
		})
		return { project: [], user: [] }
	}

	const scopes = options?.allowedScopes
	const mayScan = (scope: PluginScope): boolean => !scopes || scopes.includes(scope)

	const projectDir = workingDirectory
		? join(workingDirectory, PROJECT_PLUGIN_DIR)
		: join(process.cwd(), PROJECT_PLUGIN_DIR)
	const userDir = join(homedir(), USER_PLUGIN_DIR)

	const [project, user] = await Promise.all([
		mayScan('project') ? discoverPlugins(projectDir) : Promise.resolve([]),
		mayScan('user') ? discoverPlugins(userDir) : Promise.resolve([]),
	])

	logger.debug('Plugin discovery complete', {
		projectCount: project.length,
		userCount: user.length,
		...(scopes ? { allowedScopes: scopes } : {}),
	})

	return { project, user }
}
