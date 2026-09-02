import {
	PluginLifecycleManager,
	PluginRegistry,
	SkillRegistry,
	SkillTool,
	type ToolRegistry,
	attachShellHooks,
	discoverAllPluginDirs,
} from '@namzu/sdk'

import type { HooksConfig, PluginConfig, PluginScope } from '../../config/schema.js'
import { cliLogger } from '../../logging.js'
import { resolveNamzuHome } from '../state/home.js'

export interface CliPluginRuntime {
	readonly manager: PluginLifecycleManager
	readonly skills: SkillRegistry
	readonly pluginCount: number
	close(): Promise<void>
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Build the executable extension runtime owned by one agent session.
 *
 * The exact `enabled === true` check is the default-off boundary. Nothing in
 * the plugin directories is discovered, read, or imported on every other
 * value. Callers invoke this only after project trust has pinned `cwd`.
 */
export async function createCliPluginRuntime(
	config: PluginConfig | undefined,
	tools: ToolRegistry,
	cwd: string,
	/**
	 * Operator shell hooks. They ride the same lifecycle manager plugins use,
	 * so a session with hooks and no plugins still builds one — with nothing
	 * installed, and `pluginCount` honestly 0.
	 */
	hooks?: HooksConfig,
): Promise<CliPluginRuntime | undefined> {
	const pluginsEnabled = config?.enabled === true
	const hookCount = hooks ? Object.values(hooks).reduce((n, list) => n + (list?.length ?? 0), 0) : 0
	if (!pluginsEnabled && hookCount === 0) return undefined

	const log = cliLogger()
	const userRoot = resolveNamzuHome()
	const plugins = new PluginRegistry()
	const skills = new SkillRegistry(log)
	const manager = new PluginLifecycleManager({
		pluginRegistry: plugins,
		toolRegistry: tools,
		skillRegistry: skills,
		scopeRoots: { project: cwd, user: userRoot },
		log,
		...(config?.hookTimeoutMs !== undefined ? { hookTimeoutMs: config.hookTimeoutMs } : {}),
	})
	if (hooks && hookCount > 0) attachShellHooks(manager, hooks, { cwd, log })
	const allowedScopes = config?.allowedScopes ?? (['project', 'user'] as const)
	const discovered = pluginsEnabled
		? await discoverAllPluginDirs(cwd, {
				enabled: true,
				autoDiscovery: config?.autoDiscovery ?? true,
				allowedScopes,
				userRoot,
				log,
			})
		: { project: [], user: [] }
	const installed: Awaited<ReturnType<PluginLifecycleManager['install']>>[] = []
	let ownsSkillTool = false

	try {
		for (const scope of allowedScopes) {
			const dirs = [...discovered[scope]].sort((a, b) => a.localeCompare(b))
			for (const dir of dirs) {
				const plugin = await manager.install(dir, scope as PluginScope)
				installed.push(plugin)
				await manager.enable(plugin.id)
			}
		}
		if (skills.size > 0 && !tools.has(SkillTool.name)) {
			tools.register(SkillTool)
			ownsSkillTool = true
		}
	} catch (error) {
		if (ownsSkillTool) tools.unregister(SkillTool.name)
		const cleanupErrors: unknown[] = []
		for (const plugin of [...installed].reverse()) {
			try {
				await manager.uninstall(plugin.id)
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError)
			}
		}
		const cleanupSuffix =
			cleanupErrors.length === 0
				? ''
				: ` Cleanup also failed: ${cleanupErrors.map(message).join('; ')}`
		throw new Error(`Plugin runtime could not start: ${message(error)}.${cleanupSuffix}`, {
			cause: error,
		})
	}

	let closePromise: Promise<void> | undefined
	return {
		manager,
		skills,
		pluginCount: installed.length,
		close() {
			if (closePromise) return closePromise
			closePromise = (async () => {
				const errors: unknown[] = []
				if (ownsSkillTool) {
					tools.unregister(SkillTool.name)
					ownsSkillTool = false
				}
				for (const plugin of [...installed].reverse()) {
					try {
						await manager.uninstall(plugin.id)
					} catch (error) {
						errors.push(error)
					}
				}
				if (errors.length > 0) {
					throw new AggregateError(errors, 'One or more plugins could not be uninstalled.')
				}
			})()
			return closePromise
		},
	}
}
