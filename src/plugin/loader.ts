import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
	PLUGIN_MANIFEST_FILENAME,
	PLUGIN_NAME_PATTERN,
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
	return PluginManifestSchema.parse(parsed)
}

/**
 * Validates that the plugin name matches the directory name
 * and conforms to the plugin name pattern.
 */
export function validatePluginName(name: string, dirName: string): void {
	if (!PLUGIN_NAME_PATTERN.test(name)) {
		throw new Error(
			`Plugin name "${name}" is invalid. Must be lowercase alphanumeric with hyphens (pattern: ${PLUGIN_NAME_PATTERN.source})`,
		)
	}
	if (name !== dirName) {
		throw new Error(`Plugin name "${name}" must match directory name "${dirName}"`)
	}
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
