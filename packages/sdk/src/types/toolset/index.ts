import type { LLMToolSchema, ToolDefinition, ToolPermission } from '../tool/index.js'

export type ToolCatalogSurface = 'chat' | 'cowork' | 'managed-agent' | 'worker' | 'code'

export type ToolSourceKind =
	| 'host_tool'
	| 'provider_builtin'
	| 'mcp_server'
	| 'skill'
	| 'plugin'
	| 'connector'

export type ToolLoadingMode = 'eager' | 'deferred' | 'disabled' | 'suspended'

export type ToolPermissionPolicy = 'default' | 'always_allow' | 'always_ask' | 'deny'

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
		readonly type: 'anthropic' | 'custom'
		readonly skillId: string
		readonly version?: string
	}
	readonly metadata?: Record<string, unknown>
}

export interface ToolsetPolicy {
	readonly enabled?: boolean
	readonly loading?: ToolLoadingMode
	readonly preferred?: boolean
	readonly permissionPolicy?: ToolPermissionPolicy
	readonly surfaces?: readonly ToolCatalogSurface[]
	readonly providerConfig?: Record<string, unknown>
}

export interface ToolsetDefinition {
	readonly id: string
	readonly sourceId: string
	readonly name: string
	readonly description?: string
	readonly defaultPolicy?: ToolsetPolicy
	readonly toolPolicies?: Record<string, ToolsetPolicy>
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
