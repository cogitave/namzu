---
title: Connectors and MCP
description: Build connector catalogs, expose connector instances as tools, consume remote MCP servers, and bridge connected integrations back out through MCP in @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Connectors and MCP

`@namzu/sdk` publishes a real interoperability surface beyond providers and tools. The connector layer manages long-lived external integrations inside Namzu, and the MCP layer adapts tool or resource surfaces across process boundaries.

## 1. The Mental Model

These surfaces are related, but they solve different problems:

| Surface | Owns | Main exports |
| --- | --- | --- |
| Provider | model calls | `ProviderRegistry`, `LLMProvider` |
| Tool | model-callable action | `defineTool`, `ToolRegistry` |
| Connector | reusable external integration with lifecycle | `ConnectorRegistry`, `ConnectorManager`, `HttpConnector`, `WebhookConnector` |
| MCP client | consume remote MCP tools and resources | `MCPClient`, `MCPToolDiscovery`, `mcpToolToToolDefinition` |
| MCP bridge/server | publish Namzu capabilities to MCP consumers | `MCPConnectorBridge`, `MCPServer`, `toolDefinitionToMCPTool` |

Rule of thumb:

- use connectors when Namzu owns the integration lifecycle
- use MCP when the integration already speaks MCP or must be published to MCP consumers

## 2. Register Connector Definitions Once

The connector registry stores definitions, not live connections:

```ts
import {
  ConnectorRegistry,
  HttpConnector,
  WebhookConnector,
} from '@namzu/sdk'

const connectorRegistry = new ConnectorRegistry()

const httpConnector = new HttpConnector()
const webhookConnector = new WebhookConnector()

connectorRegistry.register(httpConnector.toDefinition())
connectorRegistry.register(webhookConnector.toDefinition())
```

This is application bootstrap work. Do it once, then create live instances from those definitions as runtime config becomes available.

## 3. Create and Connect Instances

`ConnectorManager` owns the live lifecycle:

```ts
import { ConnectorManager } from '@namzu/sdk'

const manager = new ConnectorManager({ registry: connectorRegistry })

const docsApi = await manager.createInstance(
  {
    connectorId: httpConnector.id,
    name: 'docs-api',
    auth: {
      type: 'bearer',
      credentials: {
        token: process.env.DOCS_API_TOKEN!,
      },
    },
    options: {
      baseUrl: 'https://api.example.com',
      timeoutMs: 15_000,
    },
  },
  httpConnector,
)

await manager.connect(docsApi.id)

const healthy = await manager.healthCheck(docsApi.id)
console.log(healthy)
```

Important boundaries:

- `ConnectorRegistry` knows definitions
- `ConnectorManager` knows live instances and connection state
- the concrete connector object performs the actual external I/O

## 4. Execute Connector Methods Directly

You can call connected instances without going through the tool system:

```ts
const result = await manager.execute({
  instanceId: docsApi.id,
  method: 'request',
  input: {
    method: 'GET',
    path: '/status',
  },
})

console.log(result.success)
console.log(result.output)
console.log(result.durationMs)
```

This is useful for:

- diagnostics
- admin backends
- boot-time validation before tools are exposed to a model

## 5. Expose Connectors as Namzu Tools

Once a connector is connected, you can adapt it into standard Namzu tools:

```ts
import {
  ToolRegistry,
  createConnectorTools,
  allConnectorTools,
} from '@namzu/sdk'

const tools = new ToolRegistry()

// Generic gateway tools: connector_list and connector_execute
tools.register(createConnectorTools({ manager }), 'active')

// Optional: one tool per connected connector method
tools.register(allConnectorTools(manager), 'deferred')
```

Two patterns exist:

| Pattern | When it fits |
| --- | --- |
| `createConnectorTools({ manager })` | You want a small stable tool surface that routes by instance ID and method name |
| `allConnectorTools(manager)` | You want one concrete tool per connected method |

If you want one explicit router-style tool, use `createConnectorRouterTool()` or `ConnectorToolRouter`.

## 6. Consume Remote MCP Servers Inside Namzu

Use `MCPClient` when a remote server already speaks MCP and should show up as Namzu tools:

```ts
import {
  MCPClient,
  MCPToolDiscovery,
  ToolRegistry,
} from '@namzu/sdk'

const client = new MCPClient({
  serverName: 'filesystem',
  transport: {
    type: 'stdio',
    command: 'node',
    args: ['./mcp/filesystem-server.js'],
    cwd: process.cwd(),
  },
})

await client.connect()

const discovery = new MCPToolDiscovery([client])
const remoteTools = await discovery.toToolDefinitions()

const tools = new ToolRegistry()
tools.register(remoteTools, 'active')
```

The generated tool names are prefixed as:

- `mcp_<serverName>_<toolName>`

That keeps remote MCP tools distinct from local tool definitions.

## 7. Read MCP Resources and Templates

The MCP client surface is broader than tools:

```ts
const resources = await client.listResources()
const templates = await client.listResourceTemplates()

if (resources[0]) {
  const contents = await client.readResource(resources[0].uri)
  console.log(contents)
}

console.log(templates)
```

This is useful when a remote MCP server exposes documents, datasets, or templated resource URIs alongside tool calls.

## 8. Available MCP Transport Shapes

The current SDK exports two client transport shapes:

| Transport | Use it when... |
| --- | --- |
| `stdio` | The MCP server is a child process you spawn locally |
| `http-sse` | The MCP server is reachable over an HTTP-plus-SSE endpoint |

Typical `http-sse` config shape:

```ts
const client = new MCPClient({
  serverName: 'remote-server',
  transport: {
    type: 'http-sse',
    url: 'https://mcp.example.com',
    headers: {
      Authorization: `Bearer ${process.env.MCP_TOKEN!}`,
    },
  },
})
```

## 9. Publish Connected Connectors Back Out Through MCP

`MCPConnectorBridge` turns connected connector methods into MCP tool definitions:

```ts
import { MCPConnectorBridge, MCPServer } from '@namzu/sdk'

const bridge = new MCPConnectorBridge({
  manager,
  prefix: 'docs',
})

const server = new MCPServer(
  {
    name: 'docs-connectors',
    version: '1.0.0',
  },
  {
    listTools: () => bridge.listTools(),
    callTool: (name, args) => bridge.callTool(name, args),
  },
)
```

Important limitation to understand clearly:

- `MCPServer` needs an `MCPTransport` implementation that accepts inbound MCP traffic
- the SDK currently ships outbound client transports (`StdioTransport` and `HttpSseTransport`)
- in practice, server hosting usually happens inside an app shell, framework adapter, or plugin runtime that already owns the transport layer

So the bridge and server are publishable building blocks, but your host process still decides how inbound MCP traffic reaches them.

## 10. Conversion Helpers

The SDK also exports direct conversion helpers:

| Helper | Purpose |
| --- | --- |
| `mcpToolToToolDefinition()` | Turn a remote MCP tool into a Namzu tool |
| `toolDefinitionToMCPTool()` | Turn a Namzu tool into an MCP tool definition |
| `mcpToolResultToToolResult()` | Normalize remote MCP tool results into Namzu `ToolResult` |
| `toolResultToMCPToolResult()` | Convert Namzu tool results back into MCP result blocks |

Use these when you need custom adaptation logic rather than the higher-level discovery or bridge helpers.

## 11. Connector and MCP Patterns That Scale Well

For production usage:

1. register connector definitions once at app startup
2. create connector instances from tenant, project, or environment config
3. connect and health-check them before exposing tools
4. use generic connector tools for dynamic environments
5. use per-method tools only when the surface is narrow and stable
6. use `MCPClient` when the integration already ships as MCP
7. use `MCPConnectorBridge` only after connector instances are connected

That keeps lifecycle ownership explicit instead of mixing definitions, connection state, and tool exposure into one abstraction.

## Related

- [SDK Tools](../tools/README.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Plugins and MCP Servers](./plugins.md)
- [Event Bridges](./event-bridges.md)
- [SDK Runtime](../runtime/README.md)
- [Integration Folders](../architecture/integration-folders.md)
- [Connector Barrel](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/connector/index.ts)
- [Connector Tool Bridge Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/bridge/tools/connector/index.ts)
