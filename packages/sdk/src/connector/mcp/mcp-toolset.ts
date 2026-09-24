import { createHash } from 'node:crypto'
import { z } from 'zod'

import { combineToolsets } from '../../toolsets/combine.js'
import type { Toolset, ToolsetAvailability } from '../../toolsets/types.js'
import { deferred } from '../../toolsets/wrappers.js'
import type { MCPServerCapabilities } from '../../types/connector/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../../types/tool/index.js'
import type { ToolSource } from '../../types/toolset/index.js'
import { toErrorMessage } from '../../utils/error.js'
import type { Logger } from '../../utils/logger.js'
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
 * for every existing direct caller (`plugin/lifecycle.ts`, their own
 * `adapter.test.ts`, and — for now, see `connector/mcp/index.ts` —
 * `packages/cli`'s own MCP integration) — this module renames what they
 * hand back rather than changing what they produce. Plan.md §4 has them
 * stop being exported once nothing outside a toolset calls them directly;
 * that is item C1's job (it owns the CLI's own migration off the old
 * name), so both stay exported until then.
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
	 * requirement and never lowers it. See `ToolProvenance.readOnlyHintTrusted`.
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
	 * "rug pull" shape `MCPToolDiscovery` exists to catch. Reporting only:
	 * the changed/added/removed tool is admitted into the next `tools()`
	 * snapshot either way, exactly like any other change.
	 */
	readonly onDrift?: (event: { serverName: string; clientId: string; drift: MCPToolDrift }) => void
	/**
	 * How this toolset recovers a dropped connection. `{ enabled: false }`
	 * turns this off — for a caller that already runs its own
	 * `MCPReconnectSupervisor` against the same client and would otherwise
	 * end up with two supervisors racing to reconnect it.
	 */
	readonly reconnect?: MCPReconnectOptions
	readonly logger?: Logger
}

/** What `list_resources`/`read_resource` need from the enclosing closure. */
interface ResourceToolsState {
	readonly client: MCPClient
	readonly serverName: string
	readonly readOnlyHintTrusted: boolean
	admittedUris: ReadonlySet<string>
}

function buildResourceTools(state: ResourceToolsState): ToolDefinition[] {
	const { client, serverName, readOnlyHintTrusted } = state

	const listResources: ToolDefinition = {
		name: mcpToolsetName(serverName, 'list_resources'),
		description: `[MCP:${serverName}] List the resources this server publishes. Call this before "${mcpToolsetName(serverName, 'read_resource')}" — only a URI this returns may be read.`,
		inputSchema: z.object({}),
		category: 'network',
		permissions: ['network_access'],
		isReadOnly: () => true,
		isDestructive: () => false,
		isConcurrencySafe: () => true,
		provenance: { server: serverName, readOnlyHintTrusted },
		async execute(_input: unknown, context: ToolContext): Promise<ToolResult> {
			try {
				const resources = await client.listResources({ signal: context.abortSignal })
				state.admittedUris = new Set(resources.map((r) => r.uri))
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
		provenance: { server: serverName, readOnlyHintTrusted },
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
 * ## Resource tools are always deferred
 *
 * `mcp__<server>__list_resources` and `mcp__<server>__read_resource` are
 * built with `deferred(...)` regardless of `options.availability` — a
 * server's resource catalogue is usually not worth showing up front the way
 * its tools are. `Toolset.availability` is a whole-toolset default, though,
 * not a per-tool one, so this is implemented as an inner toolset (the
 * resource pair) combined with the main one via `combineToolsets` — which
 * also gives the combination `combineToolsets`'s atomic same-source
 * collision check (`ToolsetConflictError`) for free, covering a tool,
 * prompt or resource-tool name landing on the same `mcp__…` string as
 * another. **Known limitation:** `combineToolsets`'s own return carries no
 * single `.availability` (a combination is heterogeneous by nature), so
 * when a server DOES publish resources, the toolset this function returns
 * has no top-level `availability` of its own — only the two resource tools'
 * inner toolset does. A server with no resources returns the plain toolset
 * directly, and `options.availability` applies to it as expected. Revisit
 * once a later item gives `Toolset` (or its consumer) a per-tool
 * availability override.
 *
 * ## Change and reconnection
 *
 * `onChange` fires when a `tools/list_changed`, `prompts/list_changed` or
 * `resources/list_changed` notification arrives — each gated on the server
 * having advertised that capability's own `listChanged: true`, so a server
 * that never declared it cannot make this toolset re-fetch by sending the
 * notification anyway — and after every successful reconnection (the
 * server may have restarted with a different tool set, which is not a
 * notification at all). `close()` stops the reconnect supervisor this
 * function owns; pass `reconnect: { enabled: false }` when the caller runs
 * its own supervisor against the same client, to avoid two supervisors
 * racing to reconnect it.
 */
export async function mcpToolset(
	client: MCPClient,
	options: MCPToolsetOptions = {},
): Promise<Toolset> {
	const initial = client.getState()
	if (initial.status !== 'connected') {
		throw new Error(
			`mcpToolset: the MCP client for "${initial.serverName}" must be connected before its toolset is built (status: "${initial.status}").`,
		)
	}
	const serverName = initial.serverName
	const readOnlyHintTrusted = options.readOnlyHintTrusted ?? false
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
		mcpServer: { name: serverName },
	}

	const discovery = new MCPToolDiscovery([client], {
		policies: { [serverName]: { allow: options.allow, deny: options.deny } },
		onDrift: options.onDrift,
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
		toolDefs = discovered.map((d) => {
			const base = mcpToolToToolDefinition(
				d.tool,
				client,
				serverName,
				readOnlyHintTrusted,
				options.maxRetries,
			)
			// B1b/B1c: once `ToolDefinition.provenance` is removed, drop this
			// spread's `provenance` field — the owning toolset's `source` (this
			// function's `source`, above) carries the same fact from then on.
			return { ...base, name: mcpToolsetName(serverName, d.tool.name) }
		})
		rebuildMain()
	}

	async function refreshPrompts(): Promise<void> {
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
		readOnlyHintTrusted,
		admittedUris: new Set(),
	}

	async function refreshResourceUris(): Promise<void> {
		const resources = await client.listResources()
		resourceState.admittedUris = new Set(resources.map((r) => r.uri))
	}

	const supportsResources = initial.serverCapabilities?.resources !== undefined
	const resourceTools = supportsResources ? buildResourceTools(resourceState) : []

	await Promise.all([
		refreshTools(),
		refreshPrompts(),
		supportsResources ? refreshResourceUris() : Promise.resolve(),
	])

	const notify = (): void => {
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

	client.onNotification((method) => {
		if (closed) return
		if (method === 'notifications/tools/list_changed') {
			if (!currentCapabilities()?.tools?.listChanged) return
			void refreshTools().then(notify)
		} else if (method === 'notifications/prompts/list_changed') {
			if (!currentCapabilities()?.prompts?.listChanged) return
			void refreshPrompts().then(notify)
		} else if (method === 'notifications/resources/list_changed') {
			if (!currentCapabilities()?.resources?.listChanged) return
			void refreshResourceUris().then(notify)
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
			// discovery unconditionally, the same as first construction.
			await Promise.all([
				refreshTools(),
				refreshPrompts(),
				supportsResources ? refreshResourceUris() : Promise.resolve(),
			])
			if (closed) return
			notify()
			await reconnectOptions.onReconnected?.()
		},
	})
	supervisor.start()

	const close = async (): Promise<void> => {
		if (closed) return
		closed = true
		supervisor.stop()
	}

	const mainToolset: Toolset = {
		source,
		tools: () => mainTools,
		availability: options.availability,
		onChange,
		close,
	}

	if (!supportsResources) return mainToolset

	const resourceToolset: Toolset = {
		source,
		tools: () => resourceTools,
		onChange,
		close,
	}

	return combineToolsets(source, [mainToolset, deferred(resourceToolset)])
}
