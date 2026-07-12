import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpToolToToolDefinition } from '../connector/mcp/adapter.js'
import { MCPClient } from '../connector/mcp/client.js'
import { HOOK_TIMEOUT_MS, PLUGIN_NAMESPACE_SEPARATOR } from '../constants/plugin/index.js'
import { TOOL_NAME_MAX_LENGTH } from '../constants/tools/index.js'
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
import { canonicalizeToolName } from '../utils/tool-name.js'
import { interpolateEnvVars } from './env.js'
import { loadPluginManifest } from './loader.js'
import { assertNameComponent, composeToolName } from './names.js'

interface PluginContributionRecord {
	toolNames: string[]
	mcpClients: MCPClient[]
}

interface HookEntry {
	readonly pluginId: PluginId
	readonly handler: PluginHookDefinition['handler']
	/**
	 * Carried over from the hook definition at registration. Absent is read as
	 * `'error'` — the fail-closed default — so an entry that never declared a
	 * policy still blocks on a crash.
	 */
	readonly onError?: 'continue' | 'error'
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
	private hookHandlers: Map<PluginHookEvent, HookEntry[]> = new Map()
	private pluginContributions: Map<PluginId, PluginContributionRecord> = new Map()
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

		// `error` is retryable: an enable can fail for a transient reason (an MCP
		// server that was down), and the fix for a non-transient one is to edit the
		// manifest and enable again — neither should require a reinstall.
		if (
			plugin.status !== 'installed' &&
			plugin.status !== 'disabled' &&
			plugin.status !== 'error'
		) {
			throw new Error(
				`Cannot enable plugin "${plugin.manifest.name}": status is "${plugin.status}" (expected "installed", "disabled" or "error")`,
			)
		}

		const { manifest } = plugin
		const contributions: PluginContributionRecord = { toolNames: [], mcpClients: [] }

		try {
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

			// Every name that can be known from the manifest alone is validated before
			// anything is registered or spawned. An MCP server whose name cannot form a
			// legal tool name must not get as far as starting a subprocess.
			assertNameComponent(manifest.name, 'plugin', manifest.name)
			for (const serverConfig of manifest.mcpServers ?? []) {
				assertNameComponent(manifest.name, 'mcp-server', serverConfig.name)
			}

			// Plan: import the modules and compose every leaf name, so a rejected name
			// (bad component, over-length composition) throws while the registry is
			// still untouched.
			const plannedTools = await this.planPluginTools(plugin)
			const plannedHooks = await this.planPluginHooks(plugin)

			// Commit.
			for (const tool of plannedTools) {
				this.toolRegistry.register(tool, 'deferred')
				contributions.toolNames.push(tool.name)
			}

			for (const hook of plannedHooks) {
				const handlers = this.hookHandlers.get(hook.event) ?? []
				handlers.push({
					pluginId,
					handler: hook.handler,
					onError: hook.onError ?? 'error',
				})
				this.hookHandlers.set(hook.event, handlers)
			}

			// MCP tool names only exist once the server has been asked for them, so
			// this pass validates after connect but still before it registers anything.
			for (const serverConfig of manifest.mcpServers ?? []) {
				await this.attachMCPServer(pluginId, manifest.name, serverConfig, contributions)
			}
		} catch (err) {
			await this.rollbackContributions(pluginId, contributions)
			this.markError(plugin, err)
			throw err
		}

		this.pluginContributions.set(pluginId, contributions)

		const enabled: PluginDefinition = {
			...plugin,
			status: 'enabled',
			enabledAt: Date.now(),
			// Clear any message left by a previous failed enable — this one succeeded.
			error: undefined,
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

	/**
	 * Import every tool module the manifest declares and compose the namespaced
	 * name for each exported tool. Nothing is registered here — a name that cannot
	 * be composed throws before the caller mutates the registry.
	 */
	private async planPluginTools(plugin: PluginDefinition): Promise<ToolDefinition[]> {
		const { manifest } = plugin
		if (!manifest.tools || manifest.tools.length === 0) return []

		const planned: ToolDefinition[] = []
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
				const name = composeToolName(manifest.name, [{ role: 'tool', value: tool.name }])
				planned.push({ ...tool, name })
			}
		}
		return planned
	}

	private async planPluginHooks(plugin: PluginDefinition): Promise<PluginHookDefinition[]> {
		const { manifest } = plugin
		if (!manifest.hooks || manifest.hooks.length === 0) return []

		const planned: PluginHookDefinition[] = []
		for (const hookPath of manifest.hooks) {
			const absolutePath = join(plugin.rootDir, hookPath)
			const fileUrl = pathToFileURL(absolutePath).href
			const mod = (await import(fileUrl)) as { hooks?: PluginHookDefinition[] }

			if (!mod.hooks || !Array.isArray(mod.hooks)) {
				throw new Error(
					`Plugin "${manifest.name}": hook module "${hookPath}" must export a "hooks" array`,
				)
			}

			planned.push(...mod.hooks)
		}
		return planned
	}

	private async attachMCPServer(
		pluginId: PluginId,
		pluginName: string,
		config: PluginMCPServerConfig,
		contributions: PluginContributionRecord,
	): Promise<void> {
		// `env` values may reference the host environment; `command` and `args` are
		// passed through literally, because the stdio transport logs both verbatim
		// at connect and an interpolated secret there would land in the logs.
		const env = config.env ? this.resolveMCPEnv(config.env) : undefined

		const client = new MCPClient({
			serverName: config.name,
			transport: {
				type: 'stdio',
				command: config.command,
				args: config.args ? [...config.args] : undefined,
				env,
			},
		})

		// The client is recorded for rollback only once it is connected, so a connect
		// that FAILS is invisible to rollbackContributions — and a stdio transport
		// spawns its child process before the `initialize` handshake it then fails on.
		// The subprocess outlived the enable: nothing held a reference to it, and each
		// retried enable (the 'error' status is retryable) orphaned another one. It is
		// torn down here instead, and the original connect failure is what propagates —
		// a disconnect that fails on top of it must not mask the reason the enable
		// failed (ses_015 pre-freeze H1).
		try {
			await client.connect()
		} catch (connectErr) {
			try {
				await client.disconnect()
			} catch (disconnectErr) {
				this.log.warn('MCP disconnect after a failed connect also failed', {
					pluginId,
					serverName: config.name,
					error: toErrorMessage(disconnectErr),
				})
			}
			throw connectErr
		}
		contributions.mcpClients.push(client)

		// Compose every name for this server before registering any of them, so a
		// name that cannot be used leaves the server half-registered with nothing.
		const mcpTools = await client.listTools()
		const planned: ToolDefinition[] = []
		const claimedBy = new Map<string, string>()

		// The leaf is not composed against the standalone 64-character limit — it is
		// composed into `plugin__server__leaf`, so the space it actually has is what
		// the namespace leaves behind. Canonicalizing against 64 instead let a
		// repaired leaf compose past the limit and made a tool that used to fit
		// disappear.
		const leafBudget =
			TOOL_NAME_MAX_LENGTH -
			(pluginName.length + config.name.length + 2 * PLUGIN_NAMESPACE_SEPARATOR.length)

		// A registry key must not depend on the order a server happened to enumerate
		// its tools in: that order is not stable across restarts, so any decision
		// taken here on arrival order (which tool claims a name, which one is dropped)
		// could be decided differently after a reconnect, and a persisted call would
		// land on a different remote tool. Sorting by the RAW name makes the outcome a
		// pure function of the server's tool SET.
		const ordered = [...mcpTools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

		for (const mcpTool of ordered) {
			// The plugin name and the server alias come from the manifest, whose
			// author can rename them — those stay strictly validated above. The leaf
			// is the SERVER's own name for its tool: nobody here can rename a tool
			// inside someone else's MCP server, so it is canonicalized instead of
			// rejected. The server is still called with `mcpTool.name`.
			const leaf = canonicalizeToolName(mcpTool.name, leafBudget)

			let name: string
			try {
				name = composeToolName(pluginName, [
					{ role: 'mcp-server', value: config.name },
					{ role: 'tool', value: leaf },
				])
			} catch (err) {
				// Length is the one failure canonicalization cannot repair, and it is now
				// the narrow case it should be: the plugin and server names alone eat so
				// much of the 64 characters that not even a minimal repaired leaf fits.
				// Nothing this side is allowed to shorten, so the tool is dropped rather
				// than the plugin.
				this.skipMCPTool(pluginId, pluginName, config.name, mcpTool.name, toErrorMessage(err))
				continue
			}

			// Backstop, not a routine path. Canonicalization is injective — a repair
			// carries a hash of the original and the reserved suffix shape keeps the
			// repaired names apart from the untouched ones (ses_015 pre-freeze B3) — so
			// reaching here means the server advertised the same raw name twice, or a
			// 32-bit hash collision. Either way the tool is skipped and BOTH raw names
			// are reported: silently keeping whichever arrived first would let a
			// persisted canonical name invoke a different remote tool after a reconnect.
			const claimant = claimedBy.get(name)
			if (claimant !== undefined || this.toolRegistry.has(name)) {
				this.skipMCPTool(
					pluginId,
					pluginName,
					config.name,
					mcpTool.name,
					claimant !== undefined
						? `the composed name "${name}" is already claimed by this server's tool "${claimant}"`
						: `the composed name "${name}" is already registered`,
				)
				continue
			}

			const baseDef = mcpToolToToolDefinition(mcpTool, client, config.name)
			claimedBy.set(name, mcpTool.name)
			planned.push({ ...baseDef, name } satisfies ToolDefinition)
		}

		for (const tool of planned) {
			this.toolRegistry.register(tool, 'deferred')
			contributions.toolNames.push(tool.name)
		}
	}

	/**
	 * Drop one unusable tool from an MCP server and keep going. Never a rollback:
	 * the operator does not own the server's manifest and cannot act on a failure
	 * here, so failing the whole enable would leave them with a permanently
	 * un-enableable plugin and no remediation.
	 */
	private skipMCPTool(
		pluginId: PluginId,
		pluginName: string,
		serverName: string,
		toolName: string,
		reason: string,
	): void {
		this.emit({
			type: 'plugin_tool_skipped',
			pluginId,
			name: pluginName,
			serverName,
			toolName,
			reason,
		})
		this.log.warn(`Plugin "${pluginName}": skipped MCP tool "${toolName}" — ${reason}`, {
			pluginId,
			serverName,
			toolName,
		})
	}

	private resolveMCPEnv(env: Readonly<Record<string, string>>): Record<string, string> {
		const resolved: Record<string, string> = {}
		for (const [key, value] of Object.entries(env)) {
			resolved[key] = interpolateEnvVars(value, process.env, key)
		}
		return resolved
	}

	/**
	 * A plugin that failed to enable is left in `error`, not silently back in
	 * `installed`: the manifest is broken (bad name, over-long composition, dead
	 * MCP server) and re-enabling it will fail the same way until it is fixed.
	 */
	private markError(plugin: PluginDefinition, err: unknown): void {
		const message = toErrorMessage(err)
		this.pluginRegistry.register({ ...plugin, status: 'error', error: message })
		this.emit({
			type: 'plugin_error',
			pluginId: plugin.id,
			name: plugin.manifest.name,
			error: message,
		})
		this.log.error(`Plugin enable failed: ${plugin.manifest.name}`, {
			pluginId: plugin.id,
			error: message,
		})
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
			// Survives the `continue` policy below: a hook that crashed must not look
			// like a hook that ran cleanly, even when its crash is not allowed to stop
			// the run.
			let hookError: string | undefined

			try {
				result = await Promise.race([
					handlerFn(hookContext),
					new Promise<PluginHookResult>((_, reject) =>
						setTimeout(() => reject(new Error('Hook timeout')), this.hookTimeoutMs),
					),
				])
			} catch (err) {
				hookError = toErrorMessage(err)
				if (hookEntry.onError === 'continue') {
					this.log.error('Plugin hook threw; continuing (onError: continue)', {
						pluginId,
						hookEvent: event,
						error: hookError,
					})
					result = { action: 'continue' }
				} else {
					result = { action: 'error', message: hookError }
				}
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
					error: hookError,
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
