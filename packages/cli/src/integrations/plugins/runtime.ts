import { homedir } from 'node:os'

import {
	PluginLifecycleManager,
	PluginRegistry,
	SkillRegistry,
	SkillTool,
	type ToolRegistry,
	discoverAllPluginDirs,
} from '@namzu/sdk'

import type { PluginConfig, PluginScope } from '../../config/schema.js'
import { cliLogger } from '../../logging.js'

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
): Promise<CliPluginRuntime | undefined> {
	if (config?.enabled !== true) return undefined

	const log = cliLogger()
	const plugins = new PluginRegistry()
	const skills = new SkillRegistry(log)
	const manager = new PluginLifecycleManager({
		pluginRegistry: plugins,
		toolRegistry: tools,
		skillRegistry: skills,
		scopeRoots: { project: cwd, user: homedir() },
		log,
		...(config.hookTimeoutMs !== undefined ? { hookTimeoutMs: config.hookTimeoutMs } : {}),
	})
	const allowedScopes = config.allowedScopes ?? (['project', 'user'] as const)
	const discovered = await discoverAllPluginDirs(cwd, {
		enabled: true,
		autoDiscovery: config.autoDiscovery ?? true,
		allowedScopes,
		log,
	})
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
