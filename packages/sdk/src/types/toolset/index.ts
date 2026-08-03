import type { LLMToolSchema, ToolDefinition, ToolPermission } from '../tool/index.js'

/**
 * @deprecated Slated for removal in the next major. Nothing produces or
 * reads it — no code constructs any member, and `ToolsetPolicy.surfaces`,
 * the only field that carries it, is never consulted.
 *
 * It is also the wrong axis. Which tools a run may use is already
 * expressible four ways, all of them per-run and dynamic where this is
 * fixed at definition: `allowedTools` on the query, `ToolAvailability`
 * (`active` / `deferred` / `suspended`) with mid-run activation,
 * `runtimeToolOverrides`, and capability negotiation stripping tools a
 * driver cannot carry. Prefer `allowedTools`.
 *
 * The member names encode deployment shapes this kernel does not own,
 * which is the deeper reason not to keep them: a host's surfaces are the
 * host's to name.
 */
export type ToolCatalogSurface = 'chat' | 'supervised' | 'managed-agent' | 'worker' | 'code'

export type ToolSourceKind =
	| 'host_tool'
	| 'provider_builtin'
	| 'mcp_server'
	| 'skill'
	| 'plugin'
	| 'connector'

export type ToolLoadingMode = 'eager' | 'deferred' | 'disabled' | 'suspended'

export interface ToolSource {
	readonly id: string
	readonly kind: ToolSourceKind
	readonly name: string
	readonly description?: string
	readonly provider?: string
	readonly mcpServer?: {
		readonly name: string
		readonly url?: string
		readonly transport?: 'streamable_http' | 'sse' | 'stdio'
		readonly authorizationRef?: string
	}
	readonly providerTool?: {
		readonly type: string
		readonly name?: string
		readonly beta?: string
	}
	readonly skill?: {
		readonly type: 'published' | 'custom'
		readonly skillId: string
		readonly version?: string
	}
	readonly metadata?: Record<string, unknown>
}

export interface ToolsetPolicy {
	readonly enabled?: boolean
	readonly loading?: ToolLoadingMode
	readonly preferred?: boolean
	/**
	 * @deprecated Slated for removal in the next major. Never read by
	 * anything — setting it has no effect today. Use `allowedTools` on the
	 * query to bound which tools a run may use; it says the same thing per
	 * run instead of per definition. See {@link ToolCatalogSurface}.
	 */
	readonly surfaces?: readonly ToolCatalogSurface[]
	readonly providerConfig?: Record<string, unknown>
}

export interface ToolsetDefinition {
	readonly id: string
	readonly sourceId: string
	readonly name: string
	readonly description?: string
	readonly defaultPolicy?: ToolsetPolicy
	readonly metadata?: Record<string, unknown>
}

export interface ToolCatalogEntry {
	readonly name: string
	readonly description: string
	readonly sourceId: string
	readonly toolsetId: string
	readonly policy: ToolsetPolicy
	readonly definition?: ToolDefinition
	readonly llmSchema?: LLMToolSchema
	readonly permissions?: readonly ToolPermission[]
	readonly category?: ToolDefinition['category']
	readonly metadata?: Record<string, unknown>
}

export interface ToolCatalogSearchResult {
	readonly tool: ToolCatalogEntry
	readonly source: ToolSource
	readonly toolset: ToolsetDefinition
	readonly score: number
	readonly matched: readonly string[]
}

export interface ToolCatalogSnapshot {
	readonly sources: readonly ToolSource[]
	readonly toolsets: readonly ToolsetDefinition[]
	readonly tools: readonly ToolCatalogEntry[]
}
