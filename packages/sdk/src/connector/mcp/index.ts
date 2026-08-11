export { StdioTransport } from './stdio.js'
export { HttpSseTransport } from './http-sse.js'
export { StreamableHttpTransport } from './streamable-http.js'
// The server half. The three above connect this process to somebody
// else's MCP server; this one lets somebody else's client drive ours.
export { ServerStdioTransport } from './server-stdio.js'

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

export { MCPServer, MCPMethodNotFound } from './server.js'
export type {
	MCPServerToolProvider,
	MCPServerResourceProvider,
	MCPServerPromptProvider,
} from './server.js'

export type { MCPToolDiscoveryOptions } from './discovery.js'
export { applyNamePolicy, applyToolPolicy, diffTools, hasDrift, toolsHash } from './policy.js'
export type { MCPToolDrift, MCPToolPolicy, MCPToolPolicyDecision } from './policy.js'
