export { StdioTransport } from './stdio.js'
export { HttpSseTransport } from './http-sse.js'
export { StreamableHttpTransport } from './streamable-http.js'

export { MCPClient } from './client.js'

export {
	isHeaderMismatchError,
	isMissingRequiredClientCapabilityError,
	isResourceNotFoundError,
	isUnsupportedProtocolVersionError,
	MCPHttpStatusError,
	MCPInputRequiredError,
	MCPInvalidResultTypeError,
	MCPProtocolError,
} from './errors.js'

// Era resolution lives beside the client, never inside a transport: stdio
// and HTTP share the whole state machine and differ only in the probe, so
// a transport that owned a copy would strand the other one.
export {
	classifyModernHttpFailure,
	createMcpEraCache,
	defaultMcpEraCache,
	isRecognizedModernError,
	mcpEraCacheKey,
	resolveMcpEra,
} from './era.js'
export type {
	McpEraProbe,
	McpEraProbeAnswer,
	McpEraResolution,
	McpEraResolutionInput,
} from './era.js'
export { buildEnvelope, decodeResult, encodeMcpHeaderValue } from './envelope.js'
export type { McpEnvelope, McpEnvelopeInput, MCPDecodedResult } from './envelope.js'

// The repo's first refusal path: a tool definition namzu declines to expose.
// Exported so a host can ask the same question of a schema it holds — and
// because `McpEnvelopeInput.paramHeaders` names the binding type.
export { validateMcpHeaderAnnotations } from './x-mcp-header.js'
export type { McpHeaderAnnotationVerdict, McpParamHeaderBinding } from './x-mcp-header.js'

// `mcpToolset` (below) is now the ONE path new code should take onto a
// `Toolset` from MCP (plan.md §4): tools, prompts and resources, discovered,
// admitted and named together. `mcpToolToToolDefinition` and
// `mcpPromptToToolDefinition` — the pieces `mcpToolset` wraps — were planned
// to stop being exported here, but `packages/cli`'s own
// `integrations/mcp/servers.ts` still calls `mcpToolToToolDefinition`
// directly (its own naming convention, `mcp_<server>_<tool>`, predates
// `mcp__`); migrating that CLI path — its tests assert the old names — is
// item C1's job (plan.md's execution order), not this one's, so both stay
// exported until C1 lands and removes them here.
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

export { mcpToolset, mcpToolsetName } from './mcp-toolset.js'
export type { MCPToolsetOptions, MCPToolsets } from './mcp-toolset.js'

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
