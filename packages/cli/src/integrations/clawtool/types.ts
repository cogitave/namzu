/**
 * Shared types for the clawtool integration.
 *
 * Wire shapes mirror clawtool's Go source (cogitave/clawtool) verbatim so
 * upgrades on the clawtool side stay backwards-compatible without TS
 * changes. The source of truth for each shape is cited inline.
 */

/**
 * `~/.config/clawtool/daemon.json` schema. Matches the Go struct at
 * `internal/daemon/daemon.go:41-48`. Written atomically by `daemon.Ensure`.
 */
export interface DaemonState {
	readonly version: number
	readonly pid: number
	readonly port: number
	readonly started_at: string
	readonly token_file: string
	readonly log_file: string
}

/** Per-tool descriptor returned by MCP `tools/list`. */
export interface McpToolDescriptor {
	readonly name: string
	readonly description: string
	readonly inputSchema: Record<string, unknown>
}

/** Single text-content element returned in a `tools/call` result. */
export interface McpTextContent {
	readonly type: 'text'
	readonly text: string
}

/** Result envelope of a `tools/call` request. */
export interface McpCallResult {
	readonly content: readonly McpTextContent[]
	readonly isError?: boolean
}

/** Discovered + connected clawtool endpoint, returned by `ensureDaemon`. */
export interface DaemonEndpoint {
	readonly baseUrl: string
	readonly token: string
}
