import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolToToolDefinition } from '../connector/mcp/adapter.js'
import { MCPClient } from '../connector/mcp/client.js'
import {
	DEFAULT_HOOK_PRIORITY,
	HOOK_TIMEOUT_MS,
	PLUGIN_NAMESPACE_SEPARATOR,
} from '../constants/plugin/index.js'
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
	PluginMCPServerConfig,
	PluginScope,
} from '../types/plugin/index.js'
import type { RunEvent } from '../types/run/index.js'
import type { ToolDefinition, ToolRegistryContract } from '../types/tool/index.js'
import { toErrorMessage } from '../utils/error.js'
import { generatePluginId } from '../utils/id.js'
import type { Logger } from '../utils/logger.js'
import { loadPluginManifest } from './loader.js'

interface PluginContributionRecord {
	toolNames: string[]
	mcpClients: MCPClient[]
}

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
		Array<{
			pluginId: PluginId
			handler: PluginHookDefinition['handler']
			priority: number
			seq: number
		}>
	> = new Map()
	private pluginContributions: Map<PluginId, PluginContributionRecord> = new Map()
	private hookTimeoutMs: number
	private log: Logger

	constructor(config: PluginLifecycleManagerConfig) {
		this.pluginRegistry = config.pluginRegistry
		this.toolRegistry = config.toolRegistry
		this.hookTimeoutMs = config.hookTimeoutMs ?? HOOK_TIMEOUT_MS
		this.log = config.log.child({ component: 'PluginLifecycleManager' })
	}

	/**
	 * Attach a hook without installing a plugin from disk.
	 *
	 * Registration was reachable only through `enable()`, which loads a
	 * manifest and imports modules by path — so a host that wanted one
	 * in-process guard had to lay out a plugin directory to get it. That
	 * also left this class's own tests reaching into the private map,
	 * which is how they came to construct entries the real path would
	 * never produce.
	 *
	 * Hooks are held in priority order (lower first), ties keeping
	 * registration order.
	 */
	registerHook(pluginId: PluginId, hook: PluginHookDefinition): void {
		const handlers = this.hookHandlers.get(hook.event) ?? []
		handlers.push({
			pluginId,
			handler: hook.handler,
			priority: hook.priority ?? DEFAULT_HOOK_PRIORITY,
			// Registration index, so the sort has something stable to fall
			// back on when priorities are equal.
			seq: handlers.length,
		})
		// Sorted on insert rather than on dispatch: a chain runs on every
		// tool call, and the order only changes when a plugin comes or goes.
		handlers.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
		this.hookHandlers.set(hook.event, handlers)
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

		const { manifest } = plugin

		// Unsupported contribution types must fail fast (Convention #0, #5).
		// SDK lacks removable registries / instance factories / persona loader design
		// for these categories. Remove from manifest or upgrade runtime.
		const unsupported: string[] = []
		if (manifest.skills?.length) unsupported.push('skills')
		if (manifest.connectors?.length) unsupported.push('connectors')
		if (manifest.personas?.length) unsupported.push('personas')
		if (unsupported.length > 0) {
			throw new Error(
				`Plugin "${manifest.name}": contribution type(s) [${unsupported.join(', ')}] not yet supported by the runtime. Remove from manifest or upgrade @namzu/sdk.`,
			)
		}

		const contributions: PluginContributionRecord = { toolNames: [], mcpClients: [] }

		try {
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
						contributions.toolNames.push(namespacedName)
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
						this.registerHook(pluginId, hook)
					}
				}
			}

			// Start MCP servers and adapt their tools
			if (manifest.mcpServers && manifest.mcpServers.length > 0) {
				for (const serverConfig of manifest.mcpServers) {
					await this.attachMCPServer(manifest.name, serverConfig, contributions)
				}
			}
		} catch (err) {
			await this.rollbackContributions(pluginId, contributions)
			throw err
		}

		this.pluginContributions.set(pluginId, contributions)

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
			toolCount: contributions.toolNames.length,
			mcpServerCount: contributions.mcpClients.length,
		})
	}

	private async attachMCPServer(
		pluginName: string,
		config: PluginMCPServerConfig,
		contributions: PluginContributionRecord,
	): Promise<void> {
		const client = new MCPClient({
			serverName: config.name,
			transport: {
				type: 'stdio',
				command: config.command,
				args: config.args ? [...config.args] : undefined,
				env: config.env ? { ...config.env } : undefined,
			},
		})

		await client.connect()
		contributions.mcpClients.push(client)

		const mcpTools = await client.listTools()
		for (const mcpTool of mcpTools) {
			const baseDef = mcpToolToToolDefinition(mcpTool, client, config.name)
			// Double-underscore between serverName and toolName so that e.g.
			// (server="fs", tool="read_file") and (server="fs_read", tool="file")
			// produce distinct final names.
			const namespacedName = `${pluginName}${PLUGIN_NAMESPACE_SEPARATOR}mcp__${config.name}__${mcpTool.name}`
			const namespacedTool: ToolDefinition = { ...baseDef, name: namespacedName }
			this.toolRegistry.register(namespacedTool, 'deferred')
			contributions.toolNames.push(namespacedName)
		}
	}

	private async rollbackContributions(
		pluginId: PluginId,
		contributions: PluginContributionRecord,
	): Promise<void> {
		for (const name of contributions.toolNames) {
			try {
				this.toolRegistry.unregister(name)
			} catch (unregErr) {
				this.log.warn('Rollback: tool unregister failed', {
					tool: name,
					error: toErrorMessage(unregErr),
				})
			}
		}
		for (const client of contributions.mcpClients) {
			try {
				await client.disconnect()
			} catch (discErr) {
				this.log.warn('Rollback: MCP disconnect failed', {
					clientId: client.id,
					error: toErrorMessage(discErr),
				})
			}
		}
		for (const [event, handlers] of this.hookHandlers) {
			const filtered = handlers.filter((h) => h.pluginId !== pluginId)
			if (filtered.length === 0) {
				this.hookHandlers.delete(event)
			} else {
				this.hookHandlers.set(event, filtered)
			}
		}
	}

	async disable(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)

		if (plugin.status !== 'enabled') {
			throw new Error(
				`Cannot disable plugin "${plugin.manifest.name}": status is "${plugin.status}" (expected "enabled")`,
			)
		}

		const contributions = this.pluginContributions.get(pluginId) ?? {
			toolNames: [],
			mcpClients: [],
		}

		// Disconnect MCP clients first so no new tool calls can reach them mid-teardown.
		for (const client of contributions.mcpClients) {
			try {
				await client.disconnect()
			} catch (err) {
				this.log.warn('MCP client disconnect failed during disable', {
					clientId: client.id,
					error: toErrorMessage(err),
				})
			}
		}

		// Unregister contributed tools (plugin tools + MCP-adapted tools)
		for (const name of contributions.toolNames) {
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
		emitRunEvent?: (event: RunEvent) => Promise<void>,
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

		// Track input overlay so chained `modify` actions compose: each subsequent
		// hook sees the input produced by the previous hook's modify.
		let toolInputOverlay = context.toolInput

		for (const idx of indicesToProcess) {
			const hookEntry = handlers[idx]
			if (!hookEntry) continue
			const { pluginId, handler: handlerFn } = hookEntry
			const hookContext: PluginHookContext = {
				...context,
				toolInput: toolInputOverlay,
				pluginId,
				event,
			}

			if (emitRunEvent) {
				await emitRunEvent({
					type: 'plugin_hook_executing',
					runId: context.runId,
					pluginId,
					hookEvent: event,
				})
			}

			const start = performance.now()
			let result: PluginHookResult

			// The deadline timer is captured and cleared in `finally`.
			// Without that it stayed armed after the hook resolved, and an
			// armed timer keeps the Node event loop alive: hooks fire on
			// every tool call and every model call, so a run of twenty tool
			// calls left twenty live timers and the process could not exit
			// until the last one expired. Nothing failed — it just hung, for
			// up to the timeout, every time.
			const deadline = new AbortController()
			let timer: ReturnType<typeof setTimeout> | undefined

			try {
				result = await Promise.race([
					handlerFn({ ...hookContext, signal: deadline.signal }),
					new Promise<PluginHookResult>((_, reject) => {
						timer = setTimeout(() => {
							// Told, not just abandoned: a hook holding a socket
							// open can close it.
							deadline.abort()
							reject(new Error('Hook timeout'))
						}, this.hookTimeoutMs)
					}),
				])
			} catch (err) {
				const message = toErrorMessage(err)
				result = { action: 'error', message }
			} finally {
				if (timer !== undefined) clearTimeout(timer)
			}

			const durationMs = Math.round(performance.now() - start)

			this.emit({
				type: 'plugin_hook_executed',
				pluginId,
				hookEvent: event,
				durationMs,
			})

			if (emitRunEvent) {
				await emitRunEvent({
					type: 'plugin_hook_completed',
					runId: context.runId,
					pluginId,
					hookEvent: event,
					result,
				})
			}

			results.push(result)

			if (result.action === 'modify') {
				toolInputOverlay = result.input
			}

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
