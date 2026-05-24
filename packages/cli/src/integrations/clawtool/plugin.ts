/**
 * Clawtool default plugin.
 *
 * Connects to the local clawtool daemon (spawning it if necessary),
 * discovers its tool catalog via MCP `tools/list`, and adapts each tool
 * into the shape namzu's CLI consumes. The result is a proxy-tool list
 * that the agent surfaces through `namzu tools ls/run` and (later) the
 * M3 TUI's tool registry.
 *
 * Adapter contract is intentionally minimal — clawtool already enforces
 * the per-tool schema, sandboxing, and timeouts server-side. We do not
 * duplicate validation in TS; we forward the JSON Schema as-is so callers
 * (and future codegen via `sync-types`) can render it.
 */

import { type EnsureDaemonOptions, ensureDaemon } from './daemon.js'
import { ClawtoolMcpClient } from './mcp.js'
import type { DaemonEndpoint, McpCallResult, McpToolDescriptor } from './types.js'

export interface ClawtoolProxyTool {
	/** Tool name as advertised by clawtool (e.g. `Bash`, `Read`). */
	readonly name: string
	readonly description: string
	readonly inputSchema: Record<string, unknown>
	readonly source: 'clawtool'
	/** Invoke the tool via clawtool's MCP `tools/call`. */
	call(args: Record<string, unknown>): Promise<McpCallResult>
}

export interface ClawtoolPlugin {
	readonly name: 'clawtool'
	readonly endpoint: DaemonEndpoint
	readonly tools: readonly ClawtoolProxyTool[]
	/** Underlying client, exposed for diagnostics (do not use in CLI commands). */
	readonly client: ClawtoolMcpClient
}

export interface CreateClawtoolPluginOptions extends EnsureDaemonOptions {
	/** clientInfo sent on `initialize`; default `{ name: 'namzu', version: '0.0.0' }`. */
	readonly clientInfo?: { name: string; version: string }
}

export async function createClawtoolPlugin(
	opts: CreateClawtoolPluginOptions = {},
): Promise<ClawtoolPlugin> {
	const endpoint = await ensureDaemon(opts)
	const client = new ClawtoolMcpClient({
		endpoint: endpoint.baseUrl,
		token: endpoint.token,
		clientInfo: opts.clientInfo,
		fetch: opts.fetch,
	})
	const descriptors = await client.listTools()
	const tools = descriptors.map((d) => toProxyTool(d, client))
	return { name: 'clawtool', endpoint, tools, client }
}

function toProxyTool(d: McpToolDescriptor, client: ClawtoolMcpClient): ClawtoolProxyTool {
	return {
		name: d.name,
		description: d.description,
		inputSchema: d.inputSchema,
		source: 'clawtool',
		call: (args) => client.callTool(d.name, args),
	}
}
