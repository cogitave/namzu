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
		/**
		 * The operator marked this connected server's read-only claims
		 * trustworthy (plan.md §4's `readOnlyHintTrusted` option). Absent or
		 * `false` means untrusted — an unmarked server's `isReadOnly` claim
		 * raises the plan-mode bar but never lowers it on its own; see
		 * `toToolSourceRef` and `tools/trusted-read-only.ts`. One value per
		 * server, not per tool: every tool an `mcpToolset` contributes for a
		 * given server carries the same trust decision.
		 */
		readonly readOnlyHintTrusted?: boolean
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
