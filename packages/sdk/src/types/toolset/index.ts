export type ToolSourceKind =
	| 'host_tool'
	| 'provider_builtin'
	| 'mcp_server'
	| 'skill'
	| 'plugin'
	| 'connector'

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
