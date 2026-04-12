import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOOK_TIMEOUT_MS, PLUGIN_NAMESPACE_SEPARATOR } from '../constants/plugin/index.js'
import type { PluginRegistry } from '../registry/plugin/index.js'
import type { PluginId } from '../types/ids/index.js'
import type {
	PluginDefinition,
	PluginEventListener,
	PluginHookContext,
	PluginHookDefinition,
	PluginHookEvent,
	PluginHookResult,
	PluginLifecycleEvent,
	PluginScope,
} from '../types/plugin/index.js'
import type { ToolDefinition, ToolRegistryContract } from '../types/tool/index.js'
import { toErrorMessage } from '../utils/error.js'
import { generatePluginId } from '../utils/id.js'
import type { Logger } from '../utils/logger.js'
import { loadPluginManifest } from './loader.js'

export interface PluginLifecycleManagerConfig {
	pluginRegistry: PluginRegistry
	toolRegistry: ToolRegistryContract
	log: Logger
	hookTimeoutMs?: number
}

export class PluginLifecycleManager {
	private pluginRegistry: PluginRegistry
	private toolRegistry: ToolRegistryContract
	private listeners: PluginEventListener[] = []
	private hookHandlers: Map<
		PluginHookEvent,
		Array<{ pluginId: PluginId; handler: PluginHookDefinition['handler'] }>
	> = new Map()
	private pluginContributions: Map<PluginId, string[]> = new Map()
	private hookTimeoutMs: number
	private log: Logger

	constructor(config: PluginLifecycleManagerConfig) {
		this.pluginRegistry = config.pluginRegistry
		this.toolRegistry = config.toolRegistry
		this.hookTimeoutMs = config.hookTimeoutMs ?? HOOK_TIMEOUT_MS
		this.log = config.log.child({ component: 'PluginLifecycleManager' })
	}

	on(listener: PluginEventListener): void {
		this.listeners.push(listener)
	}

	off(listener: PluginEventListener): void {
		const index = this.listeners.indexOf(listener)
		if (index >= 0) this.listeners.splice(index, 1)
	}

	async install(pluginDir: string, scope: PluginScope): Promise<PluginDefinition> {
		const manifest = await loadPluginManifest(pluginDir)

		const existing = this.pluginRegistry.findByName(manifest.name)
		if (existing) {
			throw new Error(`Plugin "${manifest.name}" is already installed (id: ${existing.id})`)
		}

		const pluginId = generatePluginId()
		const definition: PluginDefinition = {
			id: pluginId,
			manifest,
			scope,
			status: 'installed',
			rootDir: pluginDir,
			installedAt: Date.now(),
		}

		this.pluginRegistry.register(definition)

		this.emit({
			type: 'plugin_installed',
			pluginId,
			name: manifest.name,
			scope,
		})

		this.log.info(`Plugin installed: ${manifest.name}`, {
			pluginId,
			scope,
			version: manifest.version,
		})

		return definition
	}

	async enable(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)

		if (plugin.status !== 'installed' && plugin.status !== 'disabled') {
			throw new Error(
				`Cannot enable plugin "${plugin.manifest.name}": status is "${plugin.status}" (expected "installed" or "disabled")`,
			)
		}

		const registeredToolNames: string[] = []
		const { manifest } = plugin

		// Load tools
		if (manifest.tools && manifest.tools.length > 0) {
			for (const toolPath of manifest.tools) {
				const absolutePath = join(plugin.rootDir, toolPath)
				const fileUrl = pathToFileURL(absolutePath).href
				const mod = (await import(fileUrl)) as { tools?: ToolDefinition[] }

				if (!mod.tools || !Array.isArray(mod.tools)) {
					throw new Error(
						`Plugin "${manifest.name}": tool module "${toolPath}" must export a "tools" array`,
					)
				}

				for (const tool of mod.tools) {
					const namespacedName = manifest.name + PLUGIN_NAMESPACE_SEPARATOR + tool.name
					const namespacedTool: ToolDefinition = { ...tool, name: namespacedName }
					this.toolRegistry.register(namespacedTool, 'deferred')
					registeredToolNames.push(namespacedName)
				}
			}
		}

		// Load hooks
		if (manifest.hooks && manifest.hooks.length > 0) {
			for (const hookPath of manifest.hooks) {
				const absolutePath = join(plugin.rootDir, hookPath)
				const fileUrl = pathToFileURL(absolutePath).href
				const mod = (await import(fileUrl)) as { hooks?: PluginHookDefinition[] }

				if (!mod.hooks || !Array.isArray(mod.hooks)) {
					throw new Error(
						`Plugin "${manifest.name}": hook module "${hookPath}" must export a "hooks" array`,
					)
				}

				for (const hook of mod.hooks) {
					const handlers = this.hookHandlers.get(hook.event) ?? []
					handlers.push({ pluginId, handler: hook.handler })
					this.hookHandlers.set(hook.event, handlers)
				}
			}
		}

		// Log unsupported contribution types
		if (manifest.skills && manifest.skills.length > 0) {
			this.log.info(`Plugin "${manifest.name}": skills contribution not yet supported`)
		}
		if (manifest.mcpServers && manifest.mcpServers.length > 0) {
			this.log.info(`Plugin "${manifest.name}": MCP servers contribution not yet supported`)
		}
		if (manifest.connectors && manifest.connectors.length > 0) {
			this.log.info(`Plugin "${manifest.name}": connectors contribution not yet supported`)
		}
		if (manifest.personas && manifest.personas.length > 0) {
			this.log.info(`Plugin "${manifest.name}": personas contribution not yet supported`)
		}

		// Track contributions for cleanup
		this.pluginContributions.set(pluginId, registeredToolNames)

		// Update status to enabled
		const enabled: PluginDefinition = {
			...plugin,
			status: 'enabled',
			enabledAt: Date.now(),
		}
		this.pluginRegistry.register(enabled)

		this.emit({
			type: 'plugin_enabled',
			pluginId,
			name: manifest.name,
		})

		this.log.info(`Plugin enabled: ${manifest.name}`, {
			pluginId,
			toolCount: registeredToolNames.length,
		})
	}

	async disable(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)

		if (plugin.status !== 'enabled') {
			throw new Error(
				`Cannot disable plugin "${plugin.manifest.name}": status is "${plugin.status}" (expected "enabled")`,
			)
		}

		// Unregister contributed tools
		const toolNames = this.pluginContributions.get(pluginId) ?? []
		for (const name of toolNames) {
			this.toolRegistry.unregister(name)
		}

		// Remove hook handlers for this plugin
		for (const [event, handlers] of this.hookHandlers) {
			const filtered = handlers.filter((h) => h.pluginId !== pluginId)
			if (filtered.length === 0) {
				this.hookHandlers.delete(event)
			} else {
				this.hookHandlers.set(event, filtered)
			}
		}

		// Clear contributions tracking
		this.pluginContributions.delete(pluginId)

		// Update status to disabled
		const disabled: PluginDefinition = {
			...plugin,
			status: 'disabled',
			enabledAt: undefined,
		}
		this.pluginRegistry.register(disabled)

		this.emit({
			type: 'plugin_disabled',
			pluginId,
			name: plugin.manifest.name,
		})

		this.log.info(`Plugin disabled: ${plugin.manifest.name}`, { pluginId })
	}

	async uninstall(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)

		if (plugin.status === 'enabled') {
			await this.disable(pluginId)
		}

		this.pluginRegistry.unregister(pluginId)

		this.emit({
			type: 'plugin_uninstalled',
			pluginId,
			name: plugin.manifest.name,
		})

		this.log.info(`Plugin uninstalled: ${plugin.manifest.name}`, { pluginId })
	}

	async executeHooks(
		event: PluginHookEvent,
		context: Omit<PluginHookContext, 'pluginId' | 'event'>,
	): Promise<PluginHookResult[]> {
		const handlers = this.hookHandlers.get(event)
		if (!handlers || handlers.length === 0) {
			return []
		}

		const results: PluginHookResult[] = []

		// Determine execution order: post_* hooks run backward (for cleanup semantics)
		const isPost = event.startsWith('post_')

		// For post_* hooks, we need to process in reverse order (last registered runs first)
		const indicesToProcess: number[] = []
		if (isPost) {
			for (let i = handlers.length - 1; i >= 0; i--) {
				indicesToProcess.push(i)
			}
		} else {
			for (let i = 0; i < handlers.length; i++) {
				indicesToProcess.push(i)
			}
		}

		for (const idx of indicesToProcess) {
			const hookEntry = handlers[idx]
			if (!hookEntry) continue
			const { pluginId, handler: handlerFn } = hookEntry
			const hookContext: PluginHookContext = {
				...context,
				pluginId,
				event,
			}

			const start = performance.now()
			let result: PluginHookResult

			try {
				result = await Promise.race([
					handlerFn(hookContext),
					new Promise<PluginHookResult>((_, reject) =>
						setTimeout(() => reject(new Error('Hook timeout')), this.hookTimeoutMs),
					),
				])
			} catch (err) {
				const message = toErrorMessage(err)
				result = { action: 'error', message }
			}

			const durationMs = Math.round(performance.now() - start)

			this.emit({
				type: 'plugin_hook_executed',
				pluginId,
				hookEvent: event,
				durationMs,
			})

			results.push(result)

			// Handle flow control: check priority order: error > skip > retry > resume > modify > continue
			// Short-circuit on error or skip; return immediately on resume or retry
			if (result.action === 'error' || result.action === 'skip') {
				break
			}
			if (result.action === 'resume' || result.action === 'retry') {
				break
			}
		}

		return results
	}

	private emit(event: PluginLifecycleEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch (err) {
				this.log.error('Plugin event listener error', {
					error: toErrorMessage(err),
				})
			}
		}
	}
}
