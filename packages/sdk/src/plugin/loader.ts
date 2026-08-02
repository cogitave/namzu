import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	PLUGIN_MANIFEST_FILENAME,
	PROJECT_PLUGIN_DIR,
	USER_PLUGIN_DIR,
} from '../constants/plugin/index.js'
import { type PluginManifest, PluginManifestSchema } from '../types/plugin/index.js'
import { getRootLogger } from '../utils/logger.js'

const logger = getRootLogger().child({ component: 'PluginLoader' })

/**
 * Scans a directory for subdirectories containing a plugin manifest.
 * Returns an array of absolute paths to plugin directories.
 */
export async function discoverPlugins(parentDir: string): Promise<string[]> {
	const dirs: string[] = []

	try {
		const entries = await readdir(parentDir)
		for (const entry of entries) {
			if (entry.startsWith('.') || entry.startsWith('_')) continue
			const fullPath = join(parentDir, entry)
			const s = await stat(fullPath)
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

/**
 * Discovers plugin directories from both project-level and user-level locations.
 * Returns categorized arrays of absolute paths.
 */
export async function discoverAllPluginDirs(
	workingDirectory?: string,
): Promise<{ project: string[]; user: string[] }> {
	const projectDir = workingDirectory
		? join(workingDirectory, PROJECT_PLUGIN_DIR)
		: join(process.cwd(), PROJECT_PLUGIN_DIR)
	const userDir = join(homedir(), USER_PLUGIN_DIR)

	const [project, user] = await Promise.all([discoverPlugins(projectDir), discoverPlugins(userDir)])

	logger.debug('Plugin discovery complete', {
		projectCount: project.length,
		userCount: user.length,
	})

	return { project, user }
}
