---
title: Plugins and MCP Servers
description: Load project or user plugins in @namzu/sdk, register namespaced tools, execute hooks, and mount plugin-managed stdio MCP servers.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk"]
---

# Plugins and MCP Servers

The plugin runtime is the SDK's project- and user-scoped extension system. It does three practical things today:

- loads namespaced tool modules
- runs hook modules over runtime phases
- starts stdio MCP servers declared by plugins and adapts their tools into the local tool registry

## 1. What the Plugin Runtime Owns Today

The public plugin surface is centered on:

| Export | Responsibility |
| --- | --- |
| `discoverPlugins()` / `discoverAllPluginDirs()` | Find plugin directories |
| `loadPluginManifest()` | Read and validate `plugin.json` |
| `PluginLifecycleManager` | Install, enable, disable, and uninstall plugins |
| `PluginResolver` | Resolve namespaced plugin components |
| `PluginRegistry` | Hold installed plugin definitions and statuses |

The runtime currently supports these manifest contribution types:

- `tools`
- `hooks`
- `mcpServers`

The runtime currently rejects these manifest contribution types at enable time:

- `skills`
- `connectors`
- `personas`

That fail-fast behavior is intentional. It is better to deny unsupported contributions clearly than to half-load a plugin and leave the runtime in an ambiguous state.

## 2. Discovery Paths and Manifest File

The plugin discovery constants point at:

- project scope: `<workingDirectory>/.namzu/plugins/<plugin-name>/plugin.json`
- user scope: `~/.namzu/plugins/<plugin-name>/plugin.json`

Minimal manifest example:

```json
{
  "name": "docs-tools",
  "version": "0.1.0",
  "description": "Project-specific Namzu tools and hooks",
  "tools": ["./tools.js"],
  "hooks": ["./hooks.js"],
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "node",
      "args": ["./mcp/filesystem-server.js"],
      "env": {
        "WORKSPACE_ROOT": "/workspace"
      }
    }
  ]
}
```

Manifest rules that matter operationally:

- `name` must be lowercase kebab-case
- `plugin.json` is validated eagerly when loaded
- contribution arrays are capped by plugin-level limits in the SDK constants

## 3. Bootstrap the Plugin Runtime

```ts
import {
  PluginRegistry,
  ToolRegistry,
  PluginLifecycleManager,
  discoverAllPluginDirs,
  getRootLogger,
} from '@namzu/sdk'

const pluginRegistry = new PluginRegistry()
const toolRegistry = new ToolRegistry()
const pluginManager = new PluginLifecycleManager({
  pluginRegistry,
  toolRegistry,
  log: getRootLogger(),
})

const pluginDirs = await discoverAllPluginDirs(process.cwd())

for (const pluginDir of pluginDirs.project) {
  const plugin = await pluginManager.install(pluginDir, 'project')
  await pluginManager.enable(plugin.id)
}
```

This gives you one important invariant:

- installation records the plugin definition
- enabling loads and registers the contributions

Those are intentionally separate lifecycle steps.

## 4. Tool Modules

A plugin tool module must export a `tools` array:

```ts
import { defineTool } from '@namzu/sdk'
import { z } from 'zod'

export const tools = [
  defineTool({
    name: 'summarize_workspace',
    description: 'Summarize the workspace state for the current run.',
    inputSchema: z.object({}),
    category: 'analysis',
    permissions: [],
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    async execute() {
      return {
        success: true,
        output: 'workspace summary placeholder',
      }
    },
  }),
]
```

When enabled, plugin tools are registered as deferred and namespaced:

- manifest name `docs-tools`
- tool name `summarize_workspace`
- final registered name `docs-tools:summarize_workspace`

That namespacing keeps plugin contributions from colliding with local or built-in tools.

## 5. Hook Modules

A plugin hook module must export a `hooks` array:

```ts
export const hooks = [
  {
    event: 'pre_tool_use',
    async handler(context) {
      if (context.toolName === 'Bash') {
        return { action: 'skip', reason: 'Bash disabled in this environment' }
      }

      return { action: 'continue' }
    },
  },
]
```

Hook events currently available:

- `run_start`
- `run_end`
- `pre_tool_use`
- `post_tool_use`
- `pre_llm_call`
- `post_llm_call`
- `iteration_start`
- `iteration_end`

## 6. Hook Ordering and Flow Control

`PluginLifecycleManager.executeHooks()` has explicit ordering semantics:

- `pre_*` hooks run in registration order
- `post_*` hooks run in reverse order
- `modify` actions compose, so each later hook sees the previous modified input
- `error` and `skip` short-circuit further hook execution
- `resume` and `retry` also stop further hook execution

The default hook timeout is five seconds unless you override `hookTimeoutMs`.

That means plugin hooks should be fast, bounded, and deliberate. They are runtime controls, not background jobs.

## 7. Plugin-Managed MCP Servers

Plugin manifests can declare `mcpServers`, but the runtime shape is important:

- each manifest entry becomes an `MCPClient`
- the transport is stdio-based today
- the runtime calls `listTools()` on the remote MCP server
- discovered remote tools are adapted into deferred, namespaced local tools

Example names:

- plugin name `fs-plugin`
- MCP server name `fs`
- remote tool `read_file`
- final tool name `fs-plugin:mcp__fs__read_file`

That naming scheme is intentional and collision-resistant.

## 8. What Plugin `mcpServers` Do Not Do

The current plugin runtime does not automatically:

- expose MCP resources or templates as local docs or tool surfaces
- use `http-sse` transport from plugin manifests
- host inbound MCP servers for other clients

The runtime path today is specifically:

1. spawn a local stdio MCP server process
2. connect as an MCP client
3. adapt remote tools into local deferred Namzu tools

## 9. Disable and Uninstall Behavior

Plugin shutdown behavior is intentionally ordered:

1. disconnect plugin-managed MCP clients
2. unregister namespaced tools
3. remove hook handlers
4. update plugin status

This matters because it prevents new remote MCP calls from reaching a client while the tool surface is being torn down.

## 10. Resolve Namespaced Plugin Components

`PluginResolver` helps when your app needs to reason about namespaced tool names:

```ts
import { PluginResolver } from '@namzu/sdk'

const resolver = new PluginResolver(pluginRegistry, toolRegistry)

console.log(resolver.resolveToolName('docs-tools:summarize_workspace'))
console.log(resolver.getPluginTools(plugin.id))
console.log(resolver.namespaceName('docs-tools', 'summarize_workspace'))
```

This is useful for:

- admin UIs
- plugin attribution in logs
- filtering or grouping tools by plugin

## 11. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| assuming plugin tools are active immediately | plugin tools are registered as deferred by default |
| assuming `skills`, `connectors`, or `personas` contributions already work | the runtime rejects those contribution types today |
| assuming plugin `mcpServers` can be configured as HTTP/SSE endpoints | manifest-driven plugin MCP currently uses stdio transport only |
| forgetting tool names are namespaced | direct activation or filtering by bare tool name will miss plugin tools |

## Related

- [SDK Tools](../tools/README.md)
- [Connectors and MCP](./connectors-and-mcp.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Event Bridges](./event-bridges.md)
- [Integration Folders](../architecture/integration-folders.md)
- [Plugin Lifecycle Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/plugin/lifecycle.ts)
- [Plugin Types Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/plugin/index.ts)
