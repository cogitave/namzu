import { createHash } from 'node:crypto'
import { z } from 'zod'

import { NAMZU } from '../../constants/telemetry/index.js'
import { ToolsetConflictError } from '../../toolsets/combine.js'
import type { Toolset, ToolsetAvailability } from '../../toolsets/types.js'
import { deferred } from '../../toolsets/wrappers.js'
import type { MCPResource, MCPServerCapabilities } from '../../types/connector/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import type { ToolSource } from '../../types/toolset/index.js'
import { toErrorMessage } from '../../utils/error.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { frameServerResult, mcpToolResultToToolResult, mcpToolToToolDefinition } from './adapter.js'
import type { MCPClient } from './client.js'
import { MCPToolDiscovery } from './discovery.js'
import type { MCPToolDrift } from './policy.js'
import { mcpPromptToToolDefinition } from './prompt-adapter.js'
import { type MCPReconnectOptions, MCPReconnectSupervisor } from './reconnect.js'

/**
 * `mcp__<server>__<rest>`, the one MCP naming convention (plan.md §4,
 * "Names become `mcp__<server>__<tool>` everywhere"). Before this, the CLI's
 * own path minted `mcp_<server>_<tool>` (single underscore, ambiguous the
 * moment either name contains one) while the plugin path already used
 * `mcp__`; this toolset is the one place both now go through.
 *
 * `mcpToolToToolDefinition`/`mcpPromptToToolDefinition` keep their OWN
 * historical naming (`mcp_<server>_<tool>` / `mcp_prompt_<server>_<name>`)
 * for remaining direct callers (`plugin/lifecycle.ts` and adapter users) —
 * this module renames what they hand back rather than changing what they
 * produce. The CLI now uses this toolset; the plugin path still uses the
 * adapters directly until its migration is complete.
 */
const MCP_TOOLSET_NAME_MAX_LENGTH = 64

/**
 * Join `serverName` and `segments` under the `mcp__` convention, shortened
 * deterministically when the result would not fit the wire's 64-character
 * tool-name ceiling.
 *
 * Never refuses a tool silently: a name over the limit is truncated and
 * given an 8-hex-character content hash suffix (`_<hash>`) instead of being
 * dropped, so two overlong names that happen to share a 55-character prefix
 * still end up distinct. The hash is over the FULL untruncated name, so
 * renaming is a pure function of `(serverName, segments)` — the same inputs
 * always shorten to the same output, which is what makes a later call
 * (`callTool`, permission rules keyed by name) able to reconstruct it.
 */
export function mcpToolsetName(serverName: string, ...segments: readonly string[]): string {
	const full = ['mcp', serverName, ...segments].join('__')
	if (full.length <= MCP_TOOLSET_NAME_MAX_LENGTH) return full
	const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
	const suffix = `_${hash}`
	return `${full.slice(0, MCP_TOOLSET_NAME_MAX_LENGTH - suffix.length)}${suffix}`
}

export interface MCPToolsetOptions {
	/**
	 * `ToolSource.id` for the returned toolset. Defaults to `mcp:<server
	 * name>`. A caller composing several servers under one namespace — a
	 * plugin's own MCP server, say — passes its own hierarchical id (for
	 * instance `plugin:<name>/mcp:<server>`) so the source id says where the
	 * connection came from, not only which server it reached.
	 */
	readonly id?: string
	/**
	 * Names (as the SERVER reports them, before the `mcp__` prefix) this
	 * toolset admits from `tools/list` and `prompts/list`. Absent admits
	 * everything, matching `MCPToolDiscovery`'s own default.
	 */
	readonly allow?: readonly string[]
	/** Names never admitted, even when `allow` lists them. */
	readonly deny?: readonly string[]
	/**
	 * In-loop retry budget for every tool this server contributes. See
	 * `mcpToolToToolDefinition`'s own `maxRetries` parameter: only a result
	 * the adapter already classifies `retrySafety: 'safe'` is ever retried,
	 * whatever this is set to.
	 */
	readonly maxRetries?: number
	/**
	 * The operator marked this server's read-only claims trustworthy. Per
	 * server, default `false` — an unmarked server's claim raises the
	 * requirement and never lowers it. The owning source carries this decision.
	 */
	readonly readOnlyHintTrusted?: boolean
	/**
	 * This toolset's own default for the tools and prompts it contributes.
	 * Absent means `'active'`. The two resource tools (`list_resources`,
	 * `read_resource`) are always `'deferred'` regardless of this — see the
	 * "resource tools are always deferred" note on {@link mcpToolset}.
	 */
	readonly availability?: ToolsetAvailability
	/**
	 * Called when a re-discovery (a `list_changed` notification, or a
	 * reconnect) finds a tool set that differs from the previous one — the
	 * "rug pull" shape `MCPToolDiscovery` exists to catch. A changed tool's
	 * previously admitted definition keeps serving for this toolset's lifetime;
	 * added and removed names apply at the next refresh boundary.
	 */
	readonly onDrift?: (event: { serverName: string; clientId: string; drift: MCPToolDrift }) => void
	/** Current tool, prompt and resource names refused by this server's policy. */
	readonly onRefused?: (event: {
		serverName: string
		clientId: string
		kind: 'tools' | 'prompts' | 'resources'
		refused: readonly { name: string; reason: 'not_allowed' | 'denied' }[]
	}) => void
	/**
	 * How this toolset recovers a dropped connection. `{ enabled: false }`
	 * turns this off — for a caller that already runs its own
	 * `MCPReconnectSupervisor` against the same client and would otherwise
	 * end up with two supervisors racing to reconnect it.
	 */
	readonly reconnect?: MCPReconnectOptions
	readonly logger?: Logger
}

/** Mount both entries: server tools use the configured availability; resource tools stay deferred. */
export type MCPToolsets = readonly [main: Toolset, resources: Toolset]

/** What `list_resources`/`read_resource` need from the enclosing closure. */
interface ResourceToolsState {
	readonly client: MCPClient
	readonly serverName: string
	admittedUris: ReadonlySet<string>
}

/**
 * Fetch and admit this server's resources, and refresh `state.admittedUris`
 * from the result — the ONLY place that set is ever written, so it can only
 * ever hold a post-policy URI. `list_resources`'s own `execute` below and
 * `mcpToolset`'s `refreshResourceUris` (construction, `resources/list_changed`,
 * reconnection) both call this rather than `client.listResources` directly,
 * which is what used to let a denied resource stay listed and readable: the
 * two callers fetched raw and set `admittedUris` from it with no policy gate
 * at all, unlike `discovery.discoverFrom`/`discoverPromptsFrom`, which both
 * already run everything through `applyNamePolicy`.
 */
async function refreshAdmittedResources(
	discovery: MCPToolDiscovery,
	state: ResourceToolsState,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	const resources = await discovery.discoverResourcesFrom(state.client, options)
	state.admittedUris = new Set(resources.map((r) => r.uri))
	return resources
}

function buildResourceTools(
	discovery: MCPToolDiscovery,
	state: ResourceToolsState,
): ToolDefinition[] {
	const { client, serverName } = state

	const listResources: ToolDefinition = {
		name: mcpToolsetName(serverName, 'list_resources'),
		description: `[MCP:${serverName}] List the resources this server publishes. Call this before "${mcpToolsetName(serverName, 'read_resource')}" — only a URI this returns may be read.`,
		inputSchema: z.object({}),
		category: 'network',
		permissions: ['network_access'],
		isReadOnly: () => true,
		isDestructive: () => false,
		isConcurrencySafe: () => true,
		async execute(_input: unknown, context: ToolContext): Promise<ToolResult> {
			try {
				const resources = await refreshAdmittedResources(discovery, state, {
					signal: context.abortSignal,
				})
				const listing = resources.map((r) => ({
					uri: r.uri,
					name: r.name,
					description: r.description,
					mimeType: r.mimeType,
				}))
				return frameServerResult(
					{ success: true, output: JSON.stringify(listing, null, 2) },
					serverName,
					'list_resources',
				)
			} catch (err) {
				return {
					success: false,
					output: '',
					error: `Could not list resources on "${serverName}": ${toErrorMessage(err)}`,
				}
			}
		},
	}

	const readResource: ToolDefinition = {
		name: mcpToolsetName(serverName, 'read_resource'),
		description: `[MCP:${serverName}] Read one resource this server publishes. "uri" must be one "${mcpToolsetName(serverName, 'list_resources')}" listed.`,
		inputSchema: z.object({
			uri: z.string().describe('A resource URI this server listed via list_resources.'),
		}),
		category: 'network',
		permissions: ['network_access'],
		isReadOnly: () => true,
		isDestructive: () => false,
		isConcurrencySafe: () => true,
		async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
			const { uri } = input as { uri: string }
			// Admission, not merely a lookup: the server does not get to decide
			// what this call may read by returning a resource it never listed.
			// `state.admittedUris` is refreshed by `list_resources` above and by
			// `resources/list_changed` (see `mcpToolset`), so a URI has to have
			// been SEEN, not merely well-formed.
			if (!state.admittedUris.has(uri)) {
				return {
					success: false,
					output: '',
					error: `"${uri}" is not a resource "${serverName}" has listed. Call "${mcpToolsetName(serverName, 'list_resources')}" first.`,
				}
			}
			try {
				const contents = await client.readResource(uri, { signal: context.abortSignal })
				const result = mcpToolResultToToolResult({ content: contents, isError: false })
				return frameServerResult(result, serverName, 'read_resource')
			} catch (err) {
				return {
					success: false,
					output: '',
					error: `Could not read resource "${uri}" from "${serverName}": ${toErrorMessage(err)}`,
				}
			}
		},
	}

	return [listResources, readResource]
}

/**
 * A connected MCP server as a live {@link Toolset}: its tools, its prompts
 * (through the existing adapters), and its resources as two deferred tools.
 *
 * The ONE path onto a `Toolset` from MCP — the CLI and a plugin both build
 * their server toolsets this way (plan.md §4). `client` must already be
 * connected; this function only discovers and wraps, it never dials.
 *
 * `options.allow`/`options.deny` govern all three surfaces a server can
 * contribute by name — tools, prompts AND resources — through
 * `MCPToolDiscovery`'s `discoverFrom`/`discoverPromptsFrom`/
 * `discoverResourcesFrom`. A denied resource is never listed and never
 * admitted into `read_resource`'s URI set, the same as a denied tool never
 * reaching `tools()`.
 *
 * ## Resource tools are always deferred
 *
 * `mcp__<server>__list_resources` and `mcp__<server>__read_resource` are
 * built with `deferred(...)` regardless of `options.availability` — a
 * server's resource catalogue is usually not worth showing up front the way
 * its tools are. `Toolset.availability` is a whole-toolset default, so this
 * function returns two toolsets to mount together: the main tools and the
 * deferred resource pair. It checks name collisions across both entries
 * before returning and after a notification refresh.
 *
 * ## Change and reconnection
 *
 * `onChange` fires when a `tools/list_changed`, `prompts/list_changed` or
 * `resources/list_changed` notification arrives — each gated on the server
 * having advertised that capability's own `listChanged: true`, so a server
 * that never declared it cannot make this toolset re-fetch by sending the
 * notification anyway — and after every successful reconnection (the
 * server may have restarted with a different tool set, which is not a
 * notification at all, and may have negotiated different capabilities
 * entirely — including resources, which is why whether the two resource
 * tools are currently present is re-checked on every reconnect rather than
 * decided once at construction). `close()` stops the reconnect supervisor
 * this function owns and releases the `onNotification` subscription it
 * registered; pass `reconnect: { enabled: false }` when the caller runs its
 * own supervisor against the same client, to avoid two supervisors racing to
 * reconnect it.
 */
export async function mcpToolset(
	client: MCPClient,
	options: MCPToolsetOptions = {},
): Promise<MCPToolsets> {
	const initial = client.getState()
	if (initial.status !== 'connected') {
		throw new Error(
			`mcpToolset: the MCP client for "${initial.serverName}" must be connected before its toolset is built (status: "${initial.status}").`,
		)
	}
	const serverName = initial.serverName
	const readOnlyHintTrusted = options.readOnlyHintTrusted ?? false
	const log = resolveLogger(options.logger).child({
		[SCOPE_ATTRIBUTE]: 'connector/mcp/mcp-toolset',
	})
	const source: ToolSource = {
		id: options.id ?? `mcp:${serverName}`,
		kind: 'mcp_server',
		name: serverName,
		// The server's own account of how to use it (`instructions`, read off
		// the last `initialize`/discover result) is remote-party text, same as
		// a tool's description — carried here rather than dropped, since a
		// host may choose to surface it (plan.md §4, CLI half).
		...(initial.serverInstructions !== undefined
			? { description: initial.serverInstructions }
			: {}),
		mcpServer: { name: serverName, readOnlyHintTrusted },
	}

	const heldToolNames = new Set<string>()
	const discovery = new MCPToolDiscovery([client], {
		policies: { [serverName]: { allow: options.allow, deny: options.deny } },
		onDrift: (event) => {
			for (const name of event.drift.changed) heldToolNames.add(name)
			options.onDrift?.(event)
		},
		onRefused: options.onRefused,
		logger: options.logger,
	})

	let toolDefs: ToolDefinition[] = []
	let promptDefs: ToolDefinition[] = []
	let mainTools: ToolDefinition[] = []
	let closed = false
	const listeners = new Set<() => void>()

	function rebuildMain(): void {
		mainTools = [...toolDefs, ...promptDefs]
	}

	async function refreshTools(): Promise<void> {
		const discovered = await discovery.discoverFrom(client)
		const previous = new Map(toolDefs.map((definition) => [definition.name, definition]))
		toolDefs = discovered.map((d) => {
			const name = mcpToolsetName(serverName, d.tool.name)
			const admitted = previous.get(name)
			if (admitted && heldToolNames.has(d.tool.name)) return admitted
			const base = mcpToolToToolDefinition(
				d.tool,
				client,
				serverName,
				readOnlyHintTrusted,
				options.maxRetries,
			)
			return { ...base, name }
		})
		for (const name of heldToolNames) {
			if (!discovered.some((entry) => entry.tool.name === name)) heldToolNames.delete(name)
		}
		rebuildMain()
	}

	async function refreshPrompts(): Promise<void> {
		if (!client.getState().serverCapabilities?.prompts) {
			promptDefs = []
			rebuildMain()
			return
		}
		const prompts = await discovery.discoverPromptsFrom(client)
		promptDefs = prompts.map((p) => {
			const base = mcpPromptToToolDefinition(p, client, serverName)
			return { ...base, name: mcpToolsetName(serverName, 'prompt', p.name) }
		})
		rebuildMain()
	}

	const resourceState: ResourceToolsState = {
		client,
		serverName,
		admittedUris: new Set(),
	}

	async function refreshResourceUris(): Promise<void> {
		await refreshAdmittedResources(discovery, resourceState)
	}

	// The two resource tool DEFINITIONS are built once, unconditionally — they
	// are inert until `resourceTools` (below) actually includes them. Building
	// them up front, rather than only when the server first supports
	// resources, is what lets a reconnect that negotiates the capability for
	// the FIRST time (see `syncResourceCapability`) expose them without
	// rebuilding the toolset this function returns.
	const resourceToolDefs = buildResourceTools(discovery, resourceState)
	let supportsResources = initial.serverCapabilities?.resources !== undefined
	let resourceTools: ToolDefinition[] = supportsResources ? resourceToolDefs : []

	/**
	 * Re-read whether the server currently supports resources and bring
	 * `resourceTools`/`admittedUris` into line with that — called at
	 * construction and after every reconnect, never relying on a value
	 * captured once. A server that stops advertising the capability loses its
	 * resource tools from the next `tools()` snapshot; one that gains it for
	 * the first time (a restart with a newer build, say) gets them added.
	 */
	async function syncResourceCapability(): Promise<void> {
		supportsResources = client.getState().serverCapabilities?.resources !== undefined
		resourceTools = supportsResources ? resourceToolDefs : []
		if (supportsResources) {
			await refreshResourceUris()
		} else {
			resourceState.admittedUris = new Set()
		}
	}

	await Promise.all([
		refreshTools(),
		refreshPrompts(),
		supportsResources ? refreshResourceUris() : Promise.resolve(),
	])

	const assertUnique = (): void => {
		const names = new Set<string>()
		for (const tool of [...mainTools, ...resourceTools]) {
			if (names.has(tool.name)) throw new ToolsetConflictError(tool.name, source, source)
			names.add(tool.name)
		}
	}
	assertUnique()

	const notify = (): void => {
		assertUnique()
		for (const listener of listeners) listener()
	}
	const onChange = (listener: () => void): (() => void) => {
		listeners.add(listener)
		return () => listeners.delete(listener)
	}

	// Read fresh on every notification rather than captured once: a
	// reconnect can renegotiate different capabilities, and a stale copy
	// would keep acting on what the PREVIOUS connection advertised.
	const currentCapabilities = (): MCPServerCapabilities | undefined =>
		client.getState().serverCapabilities

	// A rejection here would otherwise be a genuine unhandled promise
	// rejection: it happens inside a fire-and-forget notification callback,
	// not inside anything a caller of `mcpToolset` is awaiting, so nothing
	// upstream ever gets a chance to catch it. A transient failure on the
	// re-fetch a notification triggers (a network blip, or the connection
	// dropping around the same moment the server notified) is exactly the
	// kind of thing that must be logged, not left to crash the process.
	const onRefreshFailure = (which: string) => (err: unknown) => {
		log.error('Failed to refresh MCP tools after a server notification', {
			[NAMZU.SERVER_NAME]: serverName,
			'namzu.connector.refresh': which,
			'exception.message': toErrorMessage(err),
		})
	}

	const unsubscribeNotifications = client.onNotification((method) => {
		if (closed) return
		if (method === 'notifications/tools/list_changed') {
			if (!currentCapabilities()?.tools?.listChanged) return
			void refreshTools().then(notify).catch(onRefreshFailure('tools'))
		} else if (method === 'notifications/prompts/list_changed') {
			if (!currentCapabilities()?.prompts?.listChanged) return
			void refreshPrompts().then(notify).catch(onRefreshFailure('prompts'))
		} else if (method === 'notifications/resources/list_changed') {
			if (!currentCapabilities()?.resources?.listChanged) return
			void refreshResourceUris().then(notify).catch(onRefreshFailure('resources'))
		}
	})

	const reconnectOptions = options.reconnect ?? {}
	const supervisor = new MCPReconnectSupervisor(client, {
		...reconnectOptions,
		onReconnected: async () => {
			if (closed) return
			// The server may have come back with a different tool set entirely
			// — not a `list_changed` notification, which this reconnected
			// client has not even finished re-subscribing to yet. Re-run every
			// discovery unconditionally, the same as first construction, and
			// re-derive `supportsResources` rather than reuse the value from
			// the FIRST connection: a reconnect can renegotiate capabilities,
			// and a stale copy would keep acting on what the previous
			// connection advertised, the same reasoning `currentCapabilities`
			// above already applies to the `list_changed` gates.
			await Promise.all([refreshTools(), refreshPrompts(), syncResourceCapability()])
			if (closed) return
			notify()
			await reconnectOptions.onReconnected?.()
		},
	})
	supervisor.start()

	const close = async (): Promise<void> => {
		if (closed) return
		closed = true
		unsubscribeNotifications()
		supervisor.stop()
	}

	const mainToolset: Toolset = {
		source,
		tools: () => mainTools,
		availability: options.availability,
		onChange,
		close,
	}

	const resourceToolset: Toolset = {
		source,
		// A `let`, not a snapshot: `syncResourceCapability` reassigns this on
		// every reconnect, so a capability that appears or disappears between
		// two calls is visible without rebuilding either returned toolset.
		tools: () => resourceTools,
		onChange,
		close,
	}

	// Keep these as separate ToolManager entries. A Toolset has one availability
	// for all its tools, so merging them would silently activate the resources.
	return [mainToolset, deferred(resourceToolset)]
}
