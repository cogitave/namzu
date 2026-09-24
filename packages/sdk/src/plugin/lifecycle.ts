import { pathToFileURL } from 'node:url'
import type { ConfigRegistry } from '../config/registry.js'
import { MCPClient } from '../connector/mcp/client.js'
import { MCPToolDiscovery } from '../connector/mcp/discovery.js'
import type { MCPToolDiscoveryOptions } from '../connector/mcp/discovery.js'
import { mcpToolset } from '../connector/mcp/mcp-toolset.js'
import type { MCPToolPolicy } from '../connector/mcp/policy.js'
import { MCPReconnectOptionsSchema } from '../connector/mcp/reconnect.js'
import {
	DEFAULT_HOOK_PRIORITY,
	HOOK_TIMEOUT_MS,
	PLUGIN_NAMESPACE_SEPARATOR,
} from '../constants/plugin/index.js'
import { GENAI } from '../constants/telemetry/index.js'
import { PromptContributionRegistry } from '../prompt/contributions.js'
import type { PromptContribution } from '../prompt/contributions.js'
import type { PluginRegistry } from '../registry/plugin/index.js'
import { loadSkill } from '../skills/loader.js'
import type { SkillRegistry } from '../skills/registry.js'
import { resolveWithinReal } from '../tools/paths.js'
import { wrapUntrusted } from '../tools/untrusted-envelope.js'
import type { Toolset } from '../toolsets/types.js'
import { deferred, prefixed } from '../toolsets/wrappers.js'
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
import { assertPluginHookEvent } from '../types/plugin/index.js'
import type { SessionEvent } from '../types/session/index.js'
import type { ToolDefinition } from '../types/tool/index.js'
import { toErrorMessage } from '../utils/error.js'
import { generatePluginId } from '../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../utils/log/types.js'
import type { Logger } from '../utils/logger.js'
import { type DefinedPlugin, definePlugin } from './define.js'
import { assertEnableable, loadPluginManifest } from './loader.js'

interface PluginContributionRecord {
	toolNames: string[]
	mcpClients: MCPClient[]
	mcpToolsets: Toolset[]
	mcpUnsubscribers: Array<() => void>
	mcpNamesBySource: Map<string, Set<string>>
	/** Namespaced skill names, so rollback and disable can take them back. */
	skillNames: string[]
}

interface PluginAdmission {
	readonly id: PluginId
	readonly manifest: PluginDefinition['manifest']
	readonly scope: PluginScope
	readonly rootDir: string
	readonly installedAt: number
	readonly inCode?: DefinedPlugin
}

function immutableManifest(manifest: PluginDefinition['manifest']): PluginDefinition['manifest'] {
	const mcpServers = manifest.mcpServers?.map((server) =>
		Object.freeze({
			name: server.name,
			command: server.command,
			...(server.args ? { args: Object.freeze([...server.args]) } : {}),
			...(server.env ? { env: Object.freeze({ ...server.env }) } : {}),
		}),
	)
	return Object.freeze({
		name: manifest.name,
		version: manifest.version,
		description: manifest.description,
		...(manifest.author !== undefined ? { author: manifest.author } : {}),
		...(manifest.instructions !== undefined ? { instructions: manifest.instructions } : {}),
		...(manifest.tools ? { tools: Object.freeze([...manifest.tools]) } : {}),
		...(manifest.skills ? { skills: Object.freeze([...manifest.skills]) } : {}),
		...(manifest.hooks ? { hooks: Object.freeze([...manifest.hooks]) } : {}),
		...(mcpServers ? { mcpServers: Object.freeze(mcpServers) } : {}),
		...(manifest.connectors ? { connectors: Object.freeze([...manifest.connectors]) } : {}),
		...(manifest.personas ? { personas: Object.freeze([...manifest.personas]) } : {}),
	})
}

export interface PluginLifecycleManagerConfig {
	pluginRegistry: PluginRegistry
	/**
	 * Filesystem authorities for each plugin scope.
	 *
	 * Required because `scope` is not an authority by itself. The manager
	 * canonicalizes a plugin against the matching root before reading its
	 * manifest and repeats that admission for legacy registry records before
	 * enabling them. A project manager normally uses the trusted working
	 * directory; a user manager normally uses the user's home directory.
	 */
	scopeRoots: Readonly<Record<PluginScope, string>>
	/**
	 * Where a plugin's declared skills land.
	 *
	 * Optional, and its absence is enforced rather than tolerated: a
	 * manifest that declares skills is REFUSED when this is missing, the
	 * same way it was refused before the manifest path existed. Accepting it
	 * and dropping the skills would produce a plugin reporting `enabled`
	 * that contributes nothing its author declared.
	 */
	skillRegistry?: SkillRegistry
	log: Logger
	hookTimeoutMs?: number
	/**
	 * Where each MCP server's reconnect policy is registered, so an operator
	 * can retune it while a turn is live.
	 *
	 * Optional, and its absence is not a degraded mode: without one the
	 * supervisor uses its own defaults, which is what it did before this
	 * existed. What a registry buys is the ability to change them without
	 * restarting the process — see `config/registry.ts`.
	 */
	configRegistry?: ConfigRegistry

	/**
	 * What each MCP server a plugin brings is allowed to contribute, keyed by
	 * server name. `'*'` covers every server not named explicitly.
	 *
	 * Absent admits everything, which is what this path did unconditionally
	 * until now. `MCPToolDiscovery` has held this boundary — and the drift
	 * detection below — since it was written, and nothing outside its own
	 * tests ever constructed one: `attachMCPServer` called `listTools()`
	 * directly and registered whatever came back. So the least-privilege
	 * check existed, was tested, was exported, and was not on the path any
	 * real MCP server takes.
	 */
	mcpToolPolicies?: Readonly<Record<string, MCPToolPolicy>>

	/**
	 * Called when a server's admitted tool set differs from the last time it
	 * was discovered.
	 *
	 * Reported rather than blocked, for the reason `MCPToolDiscovery`
	 * already gives: a development server legitimately changes between sessions,
	 * while a production one changing mid-session is the rug pull — advertise
	 * something benign at approval time, swap it afterwards. Only the host
	 * knows which it is looking at.
	 */
	onMCPToolDrift?: MCPToolDiscoveryOptions['onDrift']
}

export class PluginLifecycleManager {
	private pluginRegistry: PluginRegistry
	/** Each installed plugin owns its own file source and one source per MCP server. */
	private readonly pluginFileTools = new Map<string, ToolDefinition>()
	private readonly pluginMcpTools = new Map<string, ToolDefinition>()
	private readonly mcpOwnerByName = new Map<string, string>()
	private readonly toolsetsByPlugin = new Map<PluginId, readonly Toolset[]>()
	private readonly instructions = new PromptContributionRegistry()
	private readonly toolsetChangeListeners = new Set<() => void>()
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
	/** Immutable executable admissions owned by this manager, never by the mutable registry. */
	private pluginAdmissions: Map<PluginId, PluginAdmission> = new Map()
	private hookTimeoutMs: number
	private readonly configRegistry: ConfigRegistry | undefined
	private readonly scopeRoots: Readonly<Record<PluginScope, string>>
	private log: Logger
	/**
	 * The admission boundary for everything a plugin's MCP servers advertise.
	 *
	 * One instance for the whole manager rather than one per plugin, and that
	 * is the part that matters: the instance is what remembers each server's
	 * previously admitted tool set, so a server that changes between one
	 * plugin being disabled and the next being enabled is still noticed. A
	 * per-plugin instance would forget on every teardown, which is precisely
	 * the window a rug pull uses.
	 *
	 * Its client list is deliberately left empty — `discoverFrom` takes the
	 * client directly, so registering it here would be bookkeeping nothing
	 * reads.
	 */
	private mcpDiscovery: MCPToolDiscovery
	private readonly mcpToolPolicies?: Readonly<Record<string, MCPToolPolicy>>
	private readonly onMCPToolDrift?: MCPToolDiscoveryOptions['onDrift']

	private readonly skillRegistry: SkillRegistry | undefined

	constructor(config: PluginLifecycleManagerConfig) {
		this.pluginRegistry = config.pluginRegistry
		this.skillRegistry = config.skillRegistry
		this.scopeRoots = Object.freeze({ ...config.scopeRoots })
		this.hookTimeoutMs = config.hookTimeoutMs ?? HOOK_TIMEOUT_MS
		this.configRegistry = config.configRegistry
		this.mcpToolPolicies = config.mcpToolPolicies
		this.onMCPToolDrift = config.onMCPToolDrift
		this.log = config.log.child({ [SCOPE_ATTRIBUTE]: 'plugin/lifecycle' })
		this.mcpDiscovery = new MCPToolDiscovery([], {
			...(config.mcpToolPolicies ? { policies: config.mcpToolPolicies } : {}),
			...(config.onMCPToolDrift ? { onDrift: config.onMCPToolDrift } : {}),
			logger: this.log,
		})
	}

	/** Stable entries created at install, before a host composes its ToolManager. */
	get toolsets(): readonly Toolset[] {
		return [...this.toolsetsByPlugin.values()].flat()
	}

	/** Plugin-authored request context from enabled plugins. */
	get promptContributions(): readonly PromptContribution[] {
		return this.instructions.list()
	}

	private registerToolsets(admission: PluginAdmission): void {
		if (this.toolsetsByPlugin.has(admission.id)) return
		const pluginName = admission.manifest.name
		const onChange = (listener: () => void) => {
			this.toolsetChangeListeners.add(listener)
			return () => this.toolsetChangeListeners.delete(listener)
		}
		const fileTools = deferred({
			source: { id: `plugin:${pluginName}`, kind: 'plugin' as const, name: pluginName },
			tools: () =>
				[...this.pluginFileTools.values()].filter((tool) =>
					tool.name.startsWith(`${pluginName}${PLUGIN_NAMESPACE_SEPARATOR}`),
				),
			onChange,
		})
		const mcpTools = (admission.manifest.mcpServers ?? []).map((server) =>
			deferred({
				source: {
					id: `plugin:${pluginName}/mcp:${server.name}`,
					kind: 'mcp_server' as const,
					name: server.name,
					mcpServer: { name: server.name, readOnlyHintTrusted: false },
				},
				tools: () =>
					[...this.pluginMcpTools.values()].filter(
						(tool) =>
							this.mcpOwnerByName.get(tool.name) === `plugin:${pluginName}/mcp:${server.name}`,
					),
				onChange,
			}),
		)
		this.toolsetsByPlugin.set(admission.id, [fileTools, ...mcpTools])
	}

	private notifyToolsetChange(): void {
		for (const listener of this.toolsetChangeListeners) listener()
	}

	/** A file-declared plugin tool. Always deferred, like every other tool this manager contributes. */
	private addFileTool(tool: ToolDefinition): void {
		this.pluginFileTools.set(tool.name, tool)
		this.notifyToolsetChange()
	}

	/** An MCP-discovered tool or a prompt adapted to one. */
	private addMcpTool(tool: ToolDefinition, sourceId: string): void {
		this.pluginMcpTools.set(tool.name, tool)
		this.mcpOwnerByName.set(tool.name, sourceId)
		this.notifyToolsetChange()
	}

	/** Reverses whichever of the two maps above actually holds `name`; a name in neither is a no-op. */
	private removeContributedTool(name: string): void {
		const removedFile = this.pluginFileTools.delete(name)
		const removedMcp = this.pluginMcpTools.delete(name)
		this.mcpOwnerByName.delete(name)
		if (removedFile || removedMcp) {
			this.notifyToolsetChange()
		}
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
		// Refused here rather than left to never fire: a hook module still
		// naming `run_start` would otherwise attach to an event nothing emits,
		// and the operator would learn of the rename only by its silence.
		assertPluginHookEvent(hook.event)
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
		// Admission and enable read the same constructor-owned capability. The
		// loader defaults this to false for direct callers; a manager that really
		// owns the registry is the authority that can opt the manifest in.
		const rootDir = await resolveWithinReal(this.scopeRoots[scope], pluginDir)
		const manifest = immutableManifest(
			await loadPluginManifest(rootDir, {
				skillsSupported: Boolean(this.skillRegistry),
			}),
		)

		const existing = this.pluginRegistry.findByName(manifest.name)
		if (existing) {
			throw new Error(`Plugin "${manifest.name}" is already installed (id: ${existing.id})`)
		}

		const pluginId = generatePluginId()
		const admission: PluginAdmission = Object.freeze({
			id: pluginId,
			manifest,
			scope,
			rootDir,
			installedAt: Date.now(),
		})
		const definition = this.definitionFrom(admission, 'installed')

		this.pluginRegistry.register(definition)
		this.pluginAdmissions.set(pluginId, admission)
		this.registerToolsets(admission)

		this.emit({
			type: 'plugin_installed',
			pluginId,
			name: manifest.name,
			scope,
		})

		this.log.info('Plugin installed', {
			'namzu.plugin.name': manifest.name,
			'namzu.plugin.id': pluginId,
			'namzu.plugin.scope': scope,
			'namzu.plugin.version': manifest.version,
		})

		return definition
	}

	/** Register a host-authored plugin without reading a manifest or importing modules. */
	installDefined(plugin: DefinedPlugin, scope: PluginScope = 'project'): PluginDefinition {
		const defined = definePlugin(plugin)
		const existing = this.pluginRegistry.findByName(defined.name)
		if (existing) {
			throw new Error(`Plugin "${defined.name}" is already installed (id: ${existing.id})`)
		}
		const pluginId = generatePluginId()
		const manifest = immutableManifest({
			name: defined.name,
			version: defined.version,
			description: defined.description,
			...(defined.instructions !== undefined ? { instructions: defined.instructions } : {}),
			mcpServers: defined.mcpServers,
		})
		const admission: PluginAdmission = Object.freeze({
			id: pluginId,
			manifest,
			scope,
			rootDir: this.scopeRoots[scope],
			installedAt: Date.now(),
			inCode: defined,
		})
		const definition = this.definitionFrom(admission, 'installed')
		this.pluginRegistry.register(definition)
		this.pluginAdmissions.set(pluginId, admission)
		this.registerToolsets(admission)
		this.emit({ type: 'plugin_installed', pluginId, name: defined.name, scope })
		return definition
	}

	private definitionFrom(
		admission: PluginAdmission,
		status: PluginDefinition['status'],
		enabledAt?: number,
	): PluginDefinition {
		return Object.freeze({
			...admission,
			status,
			...(enabledAt !== undefined ? { enabledAt } : {}),
		})
	}

	private async readLegacyAdmission(plugin: PluginDefinition): Promise<PluginAdmission> {
		const rootDir = await resolveWithinReal(this.scopeRoots[plugin.scope], plugin.rootDir)
		const manifest = immutableManifest(
			await loadPluginManifest(rootDir, {
				skillsSupported: Boolean(this.skillRegistry),
			}),
		)
		if (manifest.name !== plugin.manifest.name) {
			throw new Error(
				`Plugin registry record "${plugin.id}" names "${plugin.manifest.name}", but its admitted manifest names "${manifest.name}". Reinstall the plugin from its declared scope root.`,
			)
		}
		const duplicate = this.pluginRegistry
			.getAll()
			.find((candidate) => candidate.id !== plugin.id && candidate.manifest.name === manifest.name)
		if (duplicate) {
			throw new Error(
				`Plugin "${manifest.name}" is already installed (id: ${duplicate.id}); legacy record ${plugin.id} cannot be re-admitted.`,
			)
		}
		return Object.freeze({
			id: plugin.id,
			manifest,
			scope: plugin.scope,
			rootDir,
			installedAt: plugin.installedAt,
		})
	}

	async enable(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)
		let admission = this.pluginAdmissions.get(pluginId)

		// The registry is a public projection and can be overwritten by a host.
		// Contribution ownership is the executable lifecycle truth: trusting a
		// forged `disabled` status here would register every hook/tool/MCP client
		// twice and lose teardown ownership of the first set.
		if (this.pluginContributions.has(pluginId)) {
			throw new Error(
				`Cannot enable plugin "${admission?.manifest.name ?? plugin.manifest.name}": status is "enabled" (expected "installed" or "disabled")`,
			)
		}

		if (!admission) {
			if (plugin.status !== 'installed' && plugin.status !== 'disabled') {
				throw new Error(
					`Cannot enable plugin "${plugin.manifest.name}": status is "${plugin.status}" (expected "installed" or "disabled")`,
				)
			}
			try {
				admission = await this.readLegacyAdmission(plugin)
				this.pluginAdmissions.set(pluginId, admission)
				this.registerToolsets(admission)
			} catch (error) {
				this.pluginRegistry.register({
					...plugin,
					status: 'error',
					error: toErrorMessage(error),
				})
				throw error
			}
		}

		const { manifest } = admission

		// The same refusal the loader applies at install, kept here as the
		// backstop for a plugin that reached this point another way — a
		// record written by an older build, or a host constructing one
		// directly. Reaching it means the install-time gate was bypassed,
		// so the plugin transitions to `error` rather than staying
		// `installed`: a status that says the plugin is fine while it can
		// never enable is how the next reader gets misled.
		try {
			assertEnableable(manifest, { skillsSupported: Boolean(this.skillRegistry) })
		} catch (err) {
			this.pluginRegistry.register({
				...this.definitionFrom(admission, 'error'),
				error: toErrorMessage(err),
			})
			throw err
		}

		const contributions: PluginContributionRecord = {
			toolNames: [],
			mcpClients: [],
			mcpToolsets: [],
			mcpUnsubscribers: [],
			mcpNamesBySource: new Map(),
			skillNames: [],
		}

		try {
			// Host-authored definitions have no file path to resolve or module to import.
			if (admission.inCode) {
				for (const tool of admission.inCode.tools) {
					const namespacedName = manifest.name + PLUGIN_NAMESPACE_SEPARATOR + tool.name
					this.addFileTool({ ...tool, name: namespacedName })
					contributions.toolNames.push(namespacedName)
				}
			} else if (manifest.tools && manifest.tools.length > 0) {
				for (const toolPath of manifest.tools) {
					const absolutePath = await resolveWithinReal(admission.rootDir, toolPath)
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
						this.addFileTool(namespacedTool)
						contributions.toolNames.push(namespacedName)
					}
				}
			}

			// Load skills. Namespaced like tools, and for the same reason: two
			// plugins shipping `reconcile` would otherwise overwrite each
			// other in a Map keyed by the frontmatter name, and the loser
			// would vanish with nothing reporting it.
			if (manifest.skills && manifest.skills.length > 0) {
				const skillRegistry = this.skillRegistry
				if (!skillRegistry) {
					// Unreachable via `enable` — `assertEnableable` above refuses
					// first — and kept because this method is also the one a
					// future caller reaches directly. A silent skip here would
					// be the exact failure that check exists to prevent.
					throw new Error(
						`Plugin "${manifest.name}" declares skills but no SkillRegistry is configured.`,
					)
				}
				for (const skillPath of manifest.skills) {
					const absolutePath = await resolveWithinReal(admission.rootDir, skillPath)
					const { skill } = await loadSkill(absolutePath, 'metadata', this.log)
					const namespacedName = manifest.name + PLUGIN_NAMESPACE_SEPARATOR + skill.metadata.name
					skillRegistry.add(namespacedName, {
						...skill,
						metadata: { ...skill.metadata, name: namespacedName },
					})
					contributions.skillNames.push(namespacedName)
				}
			}

			// Load hooks
			if (admission.inCode) {
				for (const hook of admission.inCode.hooks) this.registerHook(pluginId, hook)
			} else if (manifest.hooks && manifest.hooks.length > 0) {
				for (const hookPath of manifest.hooks) {
					const absolutePath = await resolveWithinReal(admission.rootDir, hookPath)
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
		const pluginInstructions = manifest.instructions
		if (pluginInstructions?.trim()) {
			this.instructions.register({
				id: `plugin:${manifest.name}:instructions`,
				placement: 'context',
				render: () => {
					if (!this.pluginContributions.has(pluginId)) return null
					return wrapUntrusted(
						{
							kind: 'plugin-instructions',
							attributes: { plugin: manifest.name },
							provenance: `Plugin ${JSON.stringify(manifest.name)} supplied this text; it is plugin-authored context, not operator instructions or tool permissions.`,
						},
						pluginInstructions,
					)
				},
			})
		}

		const enabled = this.definitionFrom(admission, 'enabled', Date.now())
		this.pluginRegistry.register(enabled)

		this.emit({
			type: 'plugin_enabled',
			pluginId,
			name: manifest.name,
		})

		this.log.info('Plugin enabled', {
			// Every key namespaced, not just the newest one. Adding a bare
			// `skillCount` beside bare neighbours would have moved the
			// log-standard ratchet the wrong way for the sake of matching
			// prose that is itself the debt.
			'namzu.plugin.id': pluginId,
			'namzu.plugin.name': manifest.name,
			'namzu.plugin.tool_count':
				contributions.toolNames.length +
				[...contributions.mcpNamesBySource.values()].reduce(
					(count, names) => count + names.size,
					0,
				),
			'namzu.plugin.skill_count': contributions.skillNames.length,
			'namzu.plugin.mcp_server_count': contributions.mcpClients.length,
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
			logger: this.log,
		})

		await client.connect()
		contributions.mcpClients.push(client)

		// The toolset owns reconnection and reads this policy on each attempt.
		const policyScope = this.configRegistry?.register(
			`mcp.${config.name}`,
			MCPReconnectOptionsSchema,
		)
		// Preserve cross-disable drift detection. The live toolset below owns
		// changes during this enablement; this manager-owned discovery remembers
		// the server's earlier admission across clients and plugin lifetimes.
		await this.mcpDiscovery.discoverFrom(client)
		const sourceId = `plugin:${pluginName}/mcp:${config.name}`
		const policy = this.mcpToolPolicies?.[config.name] ?? this.mcpToolPolicies?.['*']
		const entries = await mcpToolset(client, {
			id: sourceId,
			availability: 'deferred',
			allow: policy?.allow,
			deny: policy?.deny,
			reconnect: policyScope ? () => policyScope.get() : {},
			onDrift: this.onMCPToolDrift,
			logger: this.log,
		})
		contributions.mcpToolsets.push(...entries)
		const wrapped = entries.map((entry) =>
			prefixed(entry, `${pluginName}${PLUGIN_NAMESPACE_SEPARATOR}`),
		)
		const sync = () => {
			const previous = contributions.mcpNamesBySource.get(sourceId) ?? new Set<string>()
			const nextTools = wrapped.flatMap((entry) => entry.tools())
			const nextNames = new Set(nextTools.map((tool) => tool.name))
			for (const name of previous) {
				if (!nextNames.has(name)) this.removeContributedTool(name)
			}
			for (const tool of nextTools) this.addMcpTool(tool, sourceId)
			contributions.mcpNamesBySource.set(sourceId, nextNames)
		}
		contributions.mcpUnsubscribers.push(entries[0].onChange?.(sync) ?? (() => {}))
		sync()
	}

	private async rollbackContributions(
		pluginId: PluginId,
		contributions: PluginContributionRecord,
	): Promise<void> {
		await this.stopMcpContributions(contributions, 'rollback')
		for (const name of contributions.toolNames) {
			try {
				this.removeContributedTool(name)
			} catch (unregErr) {
				this.log.warn('Rollback: tool unregister failed', {
					[GENAI.TOOL_NAME]: name,
					'exception.message': toErrorMessage(unregErr),
				})
			}
		}
		for (const name of contributions.skillNames) {
			// No try/catch: `unregister` is a Map delete and cannot throw.
			// Wrapping it would suggest a failure mode that does not exist.
			this.skillRegistry?.unregister(name)
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

	private async stopMcpContributions(
		contributions: PluginContributionRecord,
		operation: 'rollback' | 'disable',
	): Promise<void> {
		for (const unsubscribe of contributions.mcpUnsubscribers) unsubscribe()
		for (const entry of contributions.mcpToolsets) await entry.close?.()
		for (const client of contributions.mcpClients) {
			try {
				await client.disconnect()
			} catch (error) {
				this.log.warn(`MCP disconnect failed during ${operation}`, {
					'namzu.mcp.client_id': client.id,
					'exception.message': toErrorMessage(error),
				})
			}
		}
		for (const names of contributions.mcpNamesBySource.values()) {
			for (const name of names) this.removeContributedTool(name)
		}
	}

	async disable(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)
		const admission = this.pluginAdmissions.get(pluginId)
		const contributions = this.pluginContributions.get(pluginId)

		if (!contributions) {
			throw new Error(
				`Cannot disable plugin "${admission?.manifest.name ?? plugin.manifest.name}": status is not "enabled"`,
			)
		}

		await this.stopMcpContributions(contributions, 'disable')

		// Unregister file-declared tools; MCP entries were removed above.
		for (const name of contributions.toolNames) {
			this.removeContributedTool(name)
		}

		// And its skills. A disabled plugin whose skills stayed registered
		// would keep offering the model instructions from something the
		// runtime has switched off, which is worse than a stale tool: a tool
		// call would at least fail, and a skill is followed silently.
		for (const name of contributions.skillNames) {
			this.skillRegistry?.unregister(name)
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
		this.instructions.unregister(
			`plugin:${admission?.manifest.name ?? plugin.manifest.name}:instructions`,
		)

		// Update status to disabled
		const disabled: PluginDefinition = admission
			? this.definitionFrom(admission, 'disabled')
			: { ...plugin, status: 'disabled', enabledAt: undefined }
		this.pluginRegistry.register(disabled)

		this.emit({
			type: 'plugin_disabled',
			pluginId,
			name: disabled.manifest.name,
		})

		this.log.info('Plugin disabled', {
			'namzu.plugin.name': disabled.manifest.name,
			'namzu.plugin.id': pluginId,
		})
	}

	async uninstall(pluginId: PluginId): Promise<void> {
		const plugin = this.pluginRegistry.getOrThrow(pluginId)
		const admission = this.pluginAdmissions.get(pluginId)

		if (this.pluginContributions.has(pluginId)) {
			await this.disable(pluginId)
		}

		this.pluginRegistry.unregister(pluginId)
		this.instructions.unregister(
			`plugin:${admission?.manifest.name ?? plugin.manifest.name}:instructions`,
		)
		this.pluginAdmissions.delete(pluginId)
		this.toolsetsByPlugin.delete(pluginId)

		this.emit({
			type: 'plugin_uninstalled',
			pluginId,
			name: admission?.manifest.name ?? plugin.manifest.name,
		})

		this.log.info('Plugin uninstalled', {
			'namzu.plugin.name': admission?.manifest.name ?? plugin.manifest.name,
			'namzu.plugin.id': pluginId,
		})
	}

	async executeHooks(
		event: PluginHookEvent,
		context: Omit<PluginHookContext, 'pluginId' | 'event'>,
		emitSessionEvent?: (event: SessionEvent) => Promise<void>,
	): Promise<PluginHookResult[]> {
		const callerSignal = context.signal
		callerSignal?.throwIfAborted()
		const handlers = this.hookHandlers.get(event)
		if (!handlers || handlers.length === 0) {
			return []
		}

		const results: PluginHookResult[] = []
		// Interrupt hooks are cleanup/notification observers. One extension's
		// skip, error, retry, or timeout must not suppress the extensions that
		// follow it, and none of those results can change the cancellation that
		// already happened. Other hook events retain their existing flow-control
		// semantics.
		const observationalFanOut = event === 'turn_interrupt'

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

			if (emitSessionEvent) {
				await emitSessionEvent({
					type: 'plugin_hook_executing',
					sessionId: context.sessionId,
					...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
					pluginId,
					hookEvent: event,
				})
				callerSignal?.throwIfAborted()
			}

			const start = performance.now()
			let result: PluginHookResult

			// The deadline timer is captured and cleared in `finally`.
			// Without that it stayed armed after the hook resolved, and an
			// armed timer keeps the Node event loop alive: hooks fire on
			// every tool call and every model call, so a turn of twenty tool
			// calls left twenty live timers and the process could not exit
			// until the last one expired. Nothing failed — it just hung, for
			// up to the timeout, every time.
			const deadline = new AbortController()
			const hookSignal = callerSignal
				? AbortSignal.any([callerSignal, deadline.signal])
				: deadline.signal
			let timer: ReturnType<typeof setTimeout> | undefined
			let onCallerAbort: (() => void) | undefined

			try {
				const races: Promise<PluginHookResult>[] = [
					Promise.resolve().then(() => handlerFn({ ...hookContext, signal: hookSignal })),
					new Promise<PluginHookResult>((_, reject) => {
						timer = setTimeout(() => {
							// Told, not just abandoned: a hook holding a socket
							// open can close it.
							deadline.abort()
							reject(new Error('Hook timeout'))
						}, this.hookTimeoutMs)
					}),
				]
				if (callerSignal) {
					races.push(
						new Promise<PluginHookResult>((_, reject) => {
							onCallerAbort = () => reject(callerSignal.reason)
							callerSignal.addEventListener('abort', onCallerAbort, {
								once: true,
							})
							if (callerSignal.aborted) onCallerAbort()
						}),
					)
				}
				result = await Promise.race(races)
				callerSignal?.throwIfAborted()
			} catch (err) {
				// Cancellation belongs to the turn, not to the plugin. Turning it
				// into a hook error would let the query continue after its caller
				// withdrew authority and would report Stop as a plugin failure.
				if (callerSignal?.aborted) throw callerSignal.reason
				const message = toErrorMessage(err)
				result = { action: 'error', message }
			} finally {
				if (timer !== undefined) clearTimeout(timer)
				if (onCallerAbort) callerSignal?.removeEventListener('abort', onCallerAbort)
			}

			callerSignal?.throwIfAborted()
			const durationMs = Math.round(performance.now() - start)

			this.emit({
				type: 'plugin_hook_executed',
				pluginId,
				hookEvent: event,
				durationMs,
			})

			if (emitSessionEvent) {
				callerSignal?.throwIfAborted()
				await emitSessionEvent({
					type: 'plugin_hook_completed',
					sessionId: context.sessionId,
					...(context.turnId !== undefined ? { turnId: context.turnId } : {}),
					pluginId,
					hookEvent: event,
					result,
				})
				callerSignal?.throwIfAborted()
			}

			results.push(result)

			if (!observationalFanOut && result.action === 'modify') {
				toolInputOverlay = result.input
			}

			// Handle flow control: check priority order: error > skip > retry > resume > modify > continue
			// Short-circuit on error or skip; return immediately on resume or retry
			if (!observationalFanOut && (result.action === 'error' || result.action === 'skip')) {
				break
			}
			if (!observationalFanOut && result.action === 'retry') {
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
					'exception.message': toErrorMessage(err),
				})
			}
		}
	}
}
