export { StdioTransport } from './stdio.js'
export { HttpSseTransport } from './http-sse.js'
export { StreamableHttpTransport } from './streamable-http.js'

export { MCPClient } from './client.js'

export {
	mcpToolToToolDefinition,
	toolDefinitionToMCPTool,
	mcpJsonSchemaToZod,
	zodToMCPJsonSchema,
	mcpToolResultToToolResult,
	toolResultToMCPToolResult,
} from './adapter.js'

export { MCPToolDiscovery } from './discovery.js'
export { mcpPromptToToolDefinition, renderPromptMessages } from './prompt-adapter.js'

export { MCPConnectorBridge } from '../../bridge/mcp/connector/adapter.js'

// The direction reverses in `server/`: everything else in this barrel is
// this process calling somebody else's MCP server, and that subdirectory
// is somebody else's client calling ours. Re-exported from here so no
// consumer's import path changes.
export { MCPMethodNotFound, MCPServer, ServerStdioTransport } from './server/index.js'
export type {
	MCPServerPromptProvider,
	MCPServerResourceProvider,
	MCPServerToolProvider,
} from './server/index.js'

export type { MCPToolDiscoveryOptions } from './discovery.js'
export { applyNamePolicy, applyToolPolicy, diffTools, hasDrift, toolsHash } from './policy.js'
export type { MCPToolDrift, MCPToolPolicy, MCPToolPolicyDecision } from './policy.js'
