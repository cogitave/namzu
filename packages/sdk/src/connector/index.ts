export { BaseConnector } from './BaseConnector.js'

export { ConnectorRegistry } from '../registry/connector/definitions.js'
export { ScopedConnectorRegistry } from '../registry/connector/scoped.js'

export { ConnectorManager } from '../manager/connector/lifecycle.js'
export type { ConnectorManagerConfig } from '../manager/connector/lifecycle.js'

export { TenantConnectorManager } from '../manager/connector/tenant.js'
export type { TenantConnectorManagerConfig } from '../manager/connector/tenant.js'

export { EnvironmentConnectorManager } from '../manager/connector/environment.js'
export type {
	EnvironmentConnectorSetup,
	EnvironmentConnectorManagerConfig,
} from '../manager/connector/environment.js'

export { HttpConnector } from './builtins/http.js'
export { WebhookConnector } from './builtins/webhook.js'

// All five backends live in `execution/`. This block reached into two
// directories to reassemble one group, which is what let the concept sit in
// two places — a connector is one CALLER of an execution context, not the
// thing that defines one.
export {
	BaseExecutionContext,
	ExecutionContextFactory,
	HybridExecutionContext,
	LocalExecutionContext,
	RemoteExecutionContext,
} from '../execution/index.js'
export type {
	HybridExecutionContextOptions,
	LocalExecutionContextOptions,
	RemoteExecutionContextOptions,
} from '../execution/index.js'

// One seam, not two. This block used to hand-list names from the mcp LEAF
// modules while `mcp/index.ts` listed its own set, and the two diverged:
// `ServerStdioTransport` reached that barrel and stopped here, so
// `MCPServer` was public with no public way to serve it — a consumer could
// construct the thing and not run it. Sourcing from the barrel means a name
// added there cannot be silently dropped on the way out.
export {
	applyNamePolicy,
	applyToolPolicy,
	diffTools,
	hasDrift,
	HttpSseTransport,
	MCPClient,
	MCPConnectorBridge,
	MCPMethodNotFound,
	MCPServer,
	MCPToolDiscovery,
	mcpJsonSchemaToZod,
	mcpPromptToToolDefinition,
	mcpToolResultToToolResult,
	mcpToolToToolDefinition,
	renderPromptMessages,
	ServerStdioTransport,
	StdioTransport,
	StreamableHttpTransport,
	toolDefinitionToMCPTool,
	toolResultToMCPToolResult,
	toolsHash,
	zodToMCPJsonSchema,
} from './mcp/index.js'
export type {
	MCPServerPromptProvider,
	MCPServerResourceProvider,
	MCPServerToolProvider,
	MCPToolDiscoveryOptions,
	MCPToolDrift,
	MCPToolPolicy,
	MCPToolPolicyDecision,
} from './mcp/index.js'
