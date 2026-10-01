import { basename } from 'node:path'
import { discoverAllPluginDirs, loadPluginManifest, resolveWithinReal } from '@namzu/sdk'
import type { PluginConfig, PluginScope } from '../../config/schema.js'
import { resolveNamzuHome } from '../state/home.js'
import type { CliPluginRuntime } from './runtime.js'
import { PluginSettingsStore } from './settings.js'

export interface PluginInventoryEntry {
	readonly name: string
	readonly version: string
	readonly description: string
	readonly scope: PluginScope
	/** `installed` describes a manifest, not an executable contribution already running. */
	readonly status: string
	readonly startupEnabled?: boolean
	readonly startupError?: string
}

export interface PluginInventoryView {
	readonly plugins: readonly PluginInventoryEntry[]
	readonly live: boolean
	readonly canChange: boolean
	readonly notice?: string
}

const MAX_PLUGINS = 256
const text = (value: string) => value.slice(0, 2_000)

/** Reads already trusted configuration and manifests; never imports modules or starts a session. */
export async function readPluginInventory({
	cwd,
	config,
	userRoot = resolveNamzuHome(),
	runtime,
	canChange = false,
}: {
	readonly cwd: string
	readonly config?: PluginConfig
	readonly userRoot?: string
	readonly runtime?: Pick<CliPluginRuntime, 'list'>
	readonly canChange?: boolean
}): Promise<PluginInventoryView> {
	if (runtime) {
		const loaded = runtime.list()
		return {
			plugins: loaded.slice(0, MAX_PLUGINS).map((plugin) => ({
				name: text(plugin.name),
				version: text(plugin.version),
				description: text(plugin.description),
				scope: plugin.scope,
				status: text(plugin.status),
				...(plugin.startupEnabled !== undefined ? { startupEnabled: plugin.startupEnabled } : {}),
				...(plugin.startupError
					? { startupError: 'This plugin’s startup state could not be checked.' }
					: {}),
			})),
			live: true,
			canChange,
			...(loaded.length > MAX_PLUGINS
				? { notice: `Showing the first ${MAX_PLUGINS} plugins.` }
				: {}),
		}
	}
	if (config?.enabled !== true) {
		return {
			plugins: [],
			live: false,
			canChange: false,
			notice: 'Plugins are off for this project.',
		}
	}
	if (config.autoDiscovery === false) {
		return {
			plugins: [],
			live: false,
			canChange: false,
			notice: 'Plugin discovery is off for this project.',
		}
	}
	const allowedScopes = config.allowedScopes ?? ['project', 'user']
	if (allowedScopes.length === 0) {
		return {
			plugins: [],
			live: false,
			canChange: false,
			notice: 'No plugin locations are enabled for this project.',
		}
	}
	const discovered = await discoverAllPluginDirs(cwd, {
		enabled: true,
		autoDiscovery: true,
		allowedScopes,
		userRoot,
	})
	const settings = new PluginSettingsStore(userRoot)
	const plugins: PluginInventoryEntry[] = []
	const all = allowedScopes.flatMap((scope) =>
		discovered[scope].sort().map((root) => ({ scope, root })),
	)
	for (const { scope, root } of all.slice(0, MAX_PLUGINS)) {
		try {
			// Repeat the scope admission before reading, just as runtime installation does.
			const rootDir = await resolveWithinReal(scope === 'project' ? cwd : userRoot, root)
			const manifest = await loadPluginManifest(rootDir, { skillsSupported: true })
			let startupEnabled: boolean | undefined
			let startupError: string | undefined
			try {
				startupEnabled = settings.read({ rootDir, name: manifest.name })
			} catch {
				startupError = 'This plugin’s saved startup settings could not be read.'
			}
			plugins.push({
				name: text(manifest.name),
				version: text(manifest.version),
				description: text(manifest.description),
				scope,
				status: startupError ? 'error' : 'installed',
				...(startupEnabled !== undefined ? { startupEnabled } : {}),
				...(startupError ? { startupError } : {}),
			})
		} catch {
			plugins.push({
				name: text(basename(root)),
				version: '',
				description: '',
				scope,
				status: 'error',
				// Parser errors may quote manifest bytes, including credentials in MCP env.
				startupError: 'This plugin’s manifest could not be read or validated.',
			})
		}
	}
	return {
		plugins,
		live: false,
		canChange: false,
		notice:
			all.length > MAX_PLUGINS
				? `Showing the first ${MAX_PLUGINS} installed plugins. Start a conversation to manage loaded plugins.`
				: plugins.length > 0
					? 'Installed plugins. Their saved settings apply when this conversation starts.'
					: 'No plugins are installed for this project.',
	}
}
